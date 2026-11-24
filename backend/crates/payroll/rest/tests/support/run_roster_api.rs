// SPDX-License-Identifier: LicenseRef-Proprietary
//! Creating a regular run writes its roster, the members of the group's 법인, with
//! the run; a 법인 whose people cannot yet be split between several pay groups
//! refuses to start one.
use super::super::*;
use super::run_create_api::create;
use super::run_preview_api::{setup, uri};

type Line = (Option<Uuid>, Option<Uuid>, Option<Uuid>, Option<Uuid>);

async fn group_entity(pool: &PgPool, group: Uuid) -> Uuid {
    // rls-arming: ok owner reads the fixture group's legal entity.
    sqlx::query_scalar("SELECT legal_entity_id FROM pay_groups WHERE id=$1")
        .bind(group)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn workplace(pool: &PgPool, entity: Uuid) -> Uuid {
    // rls-arming: ok owner seeds a workplace; the run is created by console_rt over HTTP.
    sqlx::query_scalar("INSERT INTO workplaces (org_id,id,legal_entity_id,needs_confirmation,created_change_mode) VALUES ($1,gen_random_uuid(),$2,true,'MIGRATION') RETURNING id")
        .bind(OrgId::one().as_uuid()).bind(entity).fetch_one(pool).await.unwrap()
}

/// An employee in `unit`, assigned to `place` from before any derivable month.
async fn employee(pool: &PgPool, place: Option<(Uuid, Uuid)>, unit: Option<Uuid>) -> Uuid {
    let org = OrgId::one();
    // rls-arming: ok owner seeds People; the run is created by console_rt over HTTP.
    let id: Uuid = sqlx::query_scalar("INSERT INTO employees (org_id,company,name,source_filename,source_sheet,source_row,source_key,org_unit_id) VALUES ($1,'SAE','직원','roster.xlsx','s',1,gen_random_uuid()::text,$2) RETURNING id")
        .bind(org.as_uuid()).bind(unit).fetch_one(pool).await.unwrap();
    if let Some((entity, workplace)) = place {
        // rls-arming: ok owner seeds the dated assignment that makes the person a member.
        sqlx::query("INSERT INTO employment_assignments (org_id,employee_id,legal_entity_id,workplace_id,valid_from,cause,command_id) VALUES ($1,$2,$3,$4,DATE '2020-01-01','MIGRATION',gen_random_uuid())")
            .bind(org.as_uuid()).bind(id).bind(entity).bind(workplace).execute(pool).await.unwrap();
    }
    id
}

/// Each line's employee, 법인, 사업장 and department. Read through `to_jsonb` so a
/// schema without the placement columns reads them as absent.
async fn roster(pool: &PgPool, run: Uuid) -> Vec<Line> {
    // rls-arming: ok owner reads back what the create wrote.
    let mut lines: Vec<Line> = sqlx::query_as("SELECT employee_id, (to_jsonb(l)->>'legal_entity_id')::uuid, (to_jsonb(l)->>'workplace_id')::uuid, (to_jsonb(l)->>'org_unit_id')::uuid FROM payroll_draft_lines l WHERE run_id=$1")
        .bind(run).fetch_all(pool).await.unwrap();
    lines.sort();
    lines
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn creating_a_regular_run_writes_its_roster_in_the_same_transaction(pool: PgPool) {
    let (service, token, group, _, _) = setup(&pool).await;
    let le = group_entity(&pool, group).await;
    let other = pay_groups_api::entity(&pool, OrgId::one()).await;
    let (site, far) = (workplace(&pool, le).await, workplace(&pool, other).await);
    // rls-arming: ok owner seeds a department.
    let team: Uuid = sqlx::query_scalar("INSERT INTO org_units (org_id) VALUES ($1) RETURNING id")
        .bind(OrgId::one().as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
    let staffed = employee(&pool, Some((le, site)), Some(team)).await;
    let no_team = employee(&pool, Some((le, site)), None).await;
    employee(&pool, Some((other, far)), Some(team)).await;
    employee(&pool, None, Some(team)).await;
    let key = Uuid::new_v4().to_string();
    let created = create(service.clone(), &token, group, "REGULAR", &key).await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.json);
    let run: Uuid = serde_json::from_value(created.json["id"].clone()).unwrap();
    let written = roster(&pool, run).await;
    let replay = create(service, &token, group, "REGULAR", &key).await;
    let mut expected = vec![
        (Some(staffed), Some(le), Some(site), Some(team)),
        (Some(no_team), Some(le), Some(site), None),
    ];
    expected.sort();
    assert_eq!(
        (written, replay.status, roster(&pool, run).await.len()),
        (expected, StatusCode::CREATED, 2)
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_legal_entity_with_two_pay_groups_refuses_preview_and_create_with_a_coded_conflict(
    pool: PgPool,
) {
    let (service, token, group, actor, _) = setup(&pool).await;
    let mut second = pay_groups_api::input(group_entity(&pool, group).await);
    second["name"] = json!("모의상사 시급");
    PgPayrollStore::new(runtime_role_pool(&pool).await)
        .create_pay_group(OrgId::one(), actor, serde_json::from_value(second).unwrap())
        .await
        .unwrap();
    let preview = get(service.clone(), &uri(group, "REGULAR"), &token).await;
    let key = Uuid::new_v4().to_string();
    let created = create(service, &token, group, "REGULAR", &key).await;
    // rls-arming: ok owner checks that the refusals persisted no run and no audit.
    let written: (i64, i64) = sqlx::query_as("SELECT (SELECT count(*) FROM payroll_draft_runs), (SELECT count(*) FROM audit_events WHERE action='payroll.run_create')")
        .fetch_one(&pool).await.unwrap();
    let code = json!("pay_group_roster_ambiguous");
    assert_eq!(
        (
            (preview.status, &preview.json["error"]["code"]),
            (created.status, &created.json["error"]["code"]),
            written
        ),
        (
            (StatusCode::CONFLICT, &code),
            (StatusCode::CONFLICT, &code),
            (0, 0)
        )
    );
}
