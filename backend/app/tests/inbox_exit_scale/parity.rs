// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{
    bounded::{query, world},
    *,
};
use console_hr_adapter_postgres::exits::{
    preflight::ExitGuardsQuery, types::ConfirmEmployeeExitCaseRequest,
};
use console_kernel_core::{Timestamp, UserId};
use console_platform_authz::access::{NodeKind, load_access_subject, project};
use serde_json::json;

pub(crate) async fn principal(pool: &PgPool, org: OrgId, actor: UserId, legacy: bool) -> Principal {
    let mut tx = pool.begin().await.unwrap();
    world::arm(&mut tx, org).await;
    let subject = load_access_subject(&mut tx, org, *actor.as_uuid(), Timestamp::now_utc())
        .await
        .unwrap();
    let grants = project(&subject);
    assert!(grants.errors.is_empty());
    Principal::new(
        actor,
        org,
        BTreeSet::from([if legacy {
            Role::SuperAdmin
        } else {
            Role::Member
        }]),
        grants.branches,
    )
    .with_effective_feature_grants(grants.grants)
    .with_scope_grants(grants.scoped)
}

async fn directory_only(pool: &PgPool, org: OrgId, actor: UserId) {
    grant_exit(pool, org, actor).await;
    sqlx::query("DELETE FROM access_role_lines WHERE org_id=$1 AND domain='exit' AND role_id IN (SELECT id FROM access_roles WHERE org_id=$1 AND name_ko='퇴직 담당')")
        .bind(org.as_uuid()).execute(pool).await.unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn home_matches_confirm_and_preflight_for_every_placement_and_legacy_role(pool: PgPool) {
    let runtime = runtime_role_pool(&pool).await;
    // The conflicting placement kills either ordering of the old department/workplace CASE.
    for (label, kind, choice, unit, assignment, allowed) in [
        (
            "department",
            Some(NodeKind::Department),
            0,
            Some(1),
            None,
            true,
        ),
        (
            "workplace",
            Some(NodeKind::Workplace),
            0,
            None,
            Some((0, Some(0))),
            true,
        ),
        (
            "legal entity",
            Some(NodeKind::LegalEntity),
            0,
            None,
            Some((0, None)),
            true,
        ),
        (
            "assignment cannot override department workplace",
            Some(NodeKind::Workplace),
            0,
            Some(2),
            Some((0, Some(0))),
            false,
        ),
        (
            "department workplace overrides assignment",
            Some(NodeKind::Workplace),
            1,
            Some(2),
            Some((0, Some(0))),
            true,
        ),
        (
            "assignment cannot override department entity",
            Some(NodeKind::LegalEntity),
            0,
            Some(2),
            Some((0, Some(0))),
            false,
        ),
        (
            "department entity overrides assignment",
            Some(NodeKind::LegalEntity),
            1,
            Some(2),
            Some((0, Some(0))),
            true,
        ),
        (
            "department subtree despite other assignment",
            Some(NodeKind::Department),
            0,
            Some(1),
            Some((1, Some(1))),
            true,
        ),
        (
            "legacy role without Cedar exit lines",
            None,
            0,
            Some(2),
            Some((0, Some(0))),
            true,
        ),
    ] {
        let w = world::World::seed(&pool, &[vec![2], vec![1]]).await;
        sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) SELECT org_id,id,1,'exit',ARRAY['edit'] FROM access_roles WHERE org_id=$1")
            .bind(w.org.as_uuid()).execute(&pool).await.unwrap();
        let actor = UserId::from_uuid(w.holder(&pool, kind, false, choice).await);
        directory_only(&pool, w.org, actor).await;
        let p = principal(&pool, w.org, actor, kind.is_none()).await;
        let nodes = |kind| {
            w.nodes
                .iter()
                .filter(|n| n.kind == kind)
                .map(|n| n.id)
                .collect::<Vec<_>>()
        };
        let units = nodes(NodeKind::Department);
        let entities = nodes(NodeKind::LegalEntity);
        let workplaces = nodes(NodeKind::Workplace);
        let employee: Uuid = sqlx::query_scalar("INSERT INTO employees (org_id,company,name,source_filename,source_sheet,source_row,source_key,org_unit_id,hire_date) VALUES ($1,'회사','검증 직원','console','console',1,'parity',$2,'2020-01-01') RETURNING id")
            .bind(w.org.as_uuid()).bind(unit.map(|i| units[i])).fetch_one(&pool).await.unwrap();
        if let Some((entity, workplace)) = assignment {
            sqlx::query("INSERT INTO employment_assignments (org_id,employee_id,legal_entity_id,workplace_id,valid_from,cause,command_id) VALUES ($1,$2,$3,$4,'2020-01-01','MIGRATION',gen_random_uuid())")
                .bind(w.org.as_uuid()).bind(employee).bind(entities[entity]).bind(workplace.map(|i| workplaces[i])).execute(&pool).await.unwrap();
        }
        let (case, on): (Uuid, Date) = sqlx::query_as("INSERT INTO employee_exit_cases (org_id,employee_id,status,effective_exit_date,site_manager_note,reported_by,exit_reason_code) VALUES ($1,$2,'REPORTED',CURRENT_DATE+1,'검증',$3,'PERSONAL') RETURNING id,effective_exit_date")
            .bind(w.org.as_uuid()).bind(employee).bind(actor.as_uuid()).fetch_one(&pool).await.unwrap();
        let now = sqlx::query_scalar("SELECT clock_timestamp()")
            .fetch_one(&pool)
            .await
            .unwrap();
        let home = page(&runtime, &p, query(now, 20), &Default::default())
            .await
            .unwrap();
        let listed = home.items.iter().any(|i| i.id == format!("hr_exit:{case}"));
        let hr = HrService::new(runtime.clone());
        let preflight = hr
            .employee_exit_guards(
                p.clone(),
                employee,
                ExitGuardsQuery {
                    effective_exit_date: on.to_string(),
                    exit_reason_code: None,
                    dismissal_notice_served_on: None,
                },
            )
            .await;
        assert_eq!(
            preflight.is_ok(),
            allowed,
            "preflight {label}: {preflight:?}"
        );
        let confirm = hr.confirm_exit_case(p, None, case, serde_json::from_value::<ConfirmEmployeeExitCaseRequest>(json!({
            "signoffs": { "privacy_notice_ack": true, "korean_labor_law_ack": true, "payroll_cutoff_ack": true, "retirement_settlement_ack": true }
        })).unwrap()).await;
        assert_eq!(confirm.is_ok(), allowed, "confirm {label}: {confirm:?}");
        assert_eq!(
            listed, allowed,
            "Home must match confirm and preflight: {label}"
        );
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn exit_permit_without_directory_read_never_discloses_the_person(pool: PgPool) {
    let w = world::World::seed(&pool, &[vec![1, 1]]).await;
    sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) SELECT org_id,id,1,'exit',ARRAY['edit'] FROM access_roles WHERE org_id=$1")
        .bind(w.org.as_uuid()).execute(&pool).await.unwrap();
    let actor = UserId::from_uuid(w.holder(&pool, Some(NodeKind::Department), false, 0).await);
    // Exit is tenant-wide, but directory read remains confined to the first department.
    grant_exit(&pool, w.org, actor).await;
    sqlx::query("DELETE FROM access_role_lines WHERE org_id=$1 AND domain='hr_basic' AND role_id IN (SELECT id FROM access_roles WHERE org_id=$1 AND name_ko='퇴직 담당')")
        .bind(w.org.as_uuid()).execute(&pool).await.unwrap();
    let units: Vec<_> = w
        .nodes
        .iter()
        .filter(|n| n.kind == NodeKind::Department)
        .map(|n| n.id)
        .collect();
    for unit in &units {
        super::bounded::seed(&pool, w.org, actor, 1, Some(*unit)).await;
    }
    let p = principal(&pool, w.org, actor, false).await;
    let runtime = runtime_role_pool(&pool).await;
    let now = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&pool)
        .await
        .unwrap();
    let home = page(&runtime, &p, query(now, 20), &Default::default())
        .await
        .unwrap();
    assert_eq!(
        home.items.len(),
        1,
        "the other department's name must not be disclosed"
    );
    let visible: Uuid =
        sqlx::query_scalar("SELECT id FROM employees WHERE org_id=$1 AND org_unit_id=$2")
            .bind(w.org.as_uuid())
            .bind(units[0])
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        home.items[0]
            .links
            .iter()
            .any(|l| l.kind == "employee" && l.id == visible.to_string())
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn deadlines_follow_the_configured_workplace_time_zone(pool: PgPool) {
    let w = world::World::seed(&pool, &[vec![1]]).await;
    let actor = UserId::from_uuid(w.holder(&pool, Some(NodeKind::Tenant), false, 0).await);
    grant_exit(&pool, w.org, actor).await;
    let entity = w
        .nodes
        .iter()
        .find(|n| n.kind == NodeKind::LegalEntity)
        .unwrap()
        .id;
    let workplace = w
        .nodes
        .iter()
        .find(|n| n.kind == NodeKind::Workplace)
        .unwrap()
        .id;
    sqlx::query("UPDATE workplaces SET time_zone='America/New_York' WHERE id=$1")
        .bind(workplace)
        .execute(&pool)
        .await
        .unwrap();
    let employee: Uuid = sqlx::query_scalar("INSERT INTO employees (org_id,company,name,source_filename,source_sheet,source_row,source_key) VALUES ($1,'회사','검증 직원','console','console',1,'zone') RETURNING id")
        .bind(w.org.as_uuid()).fetch_one(&pool).await.unwrap();
    sqlx::query("INSERT INTO employment_assignments (org_id,employee_id,legal_entity_id,workplace_id,valid_from,cause,command_id) VALUES ($1,$2,$3,$4,'2020-01-01','MIGRATION',gen_random_uuid())")
        .bind(w.org.as_uuid()).bind(employee).bind(entity).bind(workplace).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO employee_exit_cases (org_id,employee_id,status,effective_exit_date,site_manager_note,reported_by) VALUES ($1,$2,'REPORTED','2026-03-08','검증',$3)")
        .bind(w.org.as_uuid()).bind(employee).bind(actor.as_uuid()).execute(&pool).await.unwrap();
    let expected: OffsetDateTime = sqlx::query_scalar("SELECT (DATE '2026-03-08'+TIME '23:59:59.999999') AT TIME ZONE time_zone FROM workplaces WHERE id=$1")
        .bind(workplace).fetch_one(&pool).await.unwrap();
    let p = principal(&pool, w.org, actor, false).await;
    let now = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&pool)
        .await
        .unwrap();
    let home = page(
        &runtime_role_pool(&pool).await,
        &p,
        query(now, 20),
        &Default::default(),
    )
    .await
    .unwrap();
    assert_eq!(home.items.len(), 1);
    assert_eq!(home.items[0].due, Some(expected));
}

#[path = "identity.rs"]
mod identity;

#[path = "placement.rs"]
mod placement;
