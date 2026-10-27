// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_action_inbox_application::ActionInboxPosition;
use console_kernel_core::UserId;
use console_platform_authz::access::{NodeKind, load_access_subject, project};

#[path = "../../../crates/platform/authz/tests/visible_set/world.rs"]
#[allow(dead_code)]
pub(super) mod world;

pub(super) async fn seed(pool: &PgPool, org: OrgId, actor: UserId, count: i32, unit: Option<Uuid>) {
    sqlx::query(
        "WITH people AS (INSERT INTO employees \
         (org_id,company,name,source_filename,source_sheet,source_row,source_key,org_unit_id) \
         SELECT $1,'회사','김직원','console','console',n,COALESCE($4::uuid::text,'') || ':' || n::text,$4 FROM generate_series(1,$2::int) n \
         RETURNING id,source_row) INSERT INTO employee_exit_cases \
         (org_id,employee_id,branch_id,status,effective_exit_date,site_manager_note,reported_by,created_at) \
         SELECT $1,id,(SELECT w.default_branch_id FROM org_unit_placements p JOIN workplaces w ON w.org_id=p.org_id AND w.id=p.workplace_id \
           WHERE p.org_id=$1 AND p.org_unit_id=$4 LIMIT 1),'REPORTED',CURRENT_DATE + ($2-source_row)::int,'검증',$3, \
         now() - ($2-source_row) * interval '1 second' FROM people",
    ).bind(org.as_uuid()).bind(count).bind(actor.as_uuid()).bind(unit).execute(pool).await.unwrap();
}

pub(super) fn query(now: OffsetDateTime, limit: usize) -> ActionInboxSourceQuery {
    ActionInboxSourceQuery {
        filter: Default::default(),
        require_exact_total: false,
        now,
        as_of: now,
        after: None,
        limit,
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn candidate_sql_is_bounded_and_deadline_keyset_exhausts_without_loss(pool: PgPool) {
    let org = OrgId::new();
    let actor = seed_org_and_super_admin(&pool, *org.as_uuid(), "exit-bound").await;
    sqlx::query("UPDATE users SET is_tenant_ops=true WHERE id=$1")
        .bind(actor.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    seed(&pool, org, actor, 37, None).await;
    // Mix settlement and confirmation clocks, with creation order opposite to deadline order.
    sqlx::query("UPDATE employee_exit_cases SET status='SETTLEMENT_READY' WHERE org_id=$1 AND employee_id IN (SELECT id FROM employees WHERE org_id=$1 AND source_row % 2=0)")
        .bind(org.as_uuid()).execute(&pool).await.unwrap();
    sqlx::query("UPDATE employee_exit_cases SET effective_exit_date=(SELECT MIN(effective_from)-1 FROM statutory_rules) WHERE org_id=$1 AND employee_id IN (SELECT id FROM employees WHERE org_id=$1 AND source_row=2)")
        .bind(org.as_uuid()).execute(&pool).await.unwrap();
    let principal = Principal::new(
        actor,
        org,
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    )
    .with_tenant_ops(true);
    let runtime = runtime_role_pool(&pool).await;
    let now = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&pool)
        .await
        .unwrap();
    let all = page(&runtime, &principal, query(now, 200), &Default::default())
        .await
        .unwrap();
    assert_eq!(all.items.len(), 37);
    assert_eq!(
        all.items.last().unwrap().due,
        None,
        "unknown deadlines sort last"
    );
    let mut input = query(now, 5);
    let mut seen = Vec::new();
    loop {
        let queries = trail_queries::Queries::default();
        let actual = page(&runtime, &principal, input.clone(), &Default::default())
            .with_subscriber(queries.clone())
            .await
            .unwrap();
        let statements = queries.statements();
        let candidates = statements
            .iter()
            .find(|s| s.contains("FROM employee_exit_cases c") && s.contains("e.name"))
            .unwrap();
        assert!(
            candidates.contains("LIMIT"),
            "candidate SQL must bound hydration: {candidates}"
        );
        let returned: usize = candidates
            .split("rows_returned=")
            .nth(1)
            .unwrap()
            .split_whitespace()
            .next()
            .unwrap()
            .parse()
            .unwrap();
        assert!(
            returned <= input.limit + 1,
            "hydrated {returned} rows for limit {}",
            input.limit
        );
        if actual.has_more {
            assert!(!actual.total_is_exact, "a prefix cannot be an exact total");
        }
        seen.extend(actual.items.iter().map(|i| i.id.clone()));
        if !actual.has_more {
            break;
        }
        let last = actual.items.last().expect("continuation needs a row");
        input.after = Some(ActionInboxPosition {
            due: last.due,
            created_at: last.created_at,
            id: last.id.clone(),
        });
        assert!(seen.len() <= 37, "cursor repeated rows");
    }
    assert_eq!(
        seen,
        all.items.iter().map(|i| i.id.clone()).collect::<Vec<_>>()
    );
    assert_eq!(seen.iter().collect::<BTreeSet<_>>().len(), 37);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn scoped_reported_authorization_is_flat_and_does_not_leak_other_departments(pool: PgPool) {
    let runtime = runtime_role_pool(&pool).await;
    let mut counts = Vec::new();
    for count in [1, 20] {
        let w = world::World::seed(&pool, &[vec![1, 1]]).await;
        let region: Uuid =
            sqlx::query_scalar("INSERT INTO regions (org_id,name) VALUES ($1,'검증') RETURNING id")
                .bind(w.org.as_uuid())
                .fetch_one(&pool)
                .await
                .unwrap();
        for workplace in w.nodes.iter().filter(|n| n.kind == NodeKind::Workplace) {
            let branch: Uuid = sqlx::query_scalar(
                "INSERT INTO branches (org_id,region_id,name) VALUES ($1,$2,$3) RETURNING id",
            )
            .bind(w.org.as_uuid())
            .bind(region)
            .bind(workplace.id.to_string())
            .fetch_one(&pool)
            .await
            .unwrap();
            sqlx::query("UPDATE workplaces SET default_branch_id=$2 WHERE id=$1")
                .bind(workplace.id)
                .bind(branch)
                .execute(&pool)
                .await
                .unwrap();
        }
        sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) SELECT org_id,id,1,'exit',ARRAY['edit'] FROM access_roles WHERE org_id=$1")
            .bind(w.org.as_uuid()).execute(&pool).await.unwrap();
        let actor = UserId::from_uuid(w.holder(&pool, Some(NodeKind::Department), false, 0).await);
        let units: Vec<_> = w
            .nodes
            .iter()
            .filter(|n| n.kind == NodeKind::Department)
            .map(|n| n.id)
            .collect();
        seed(&pool, w.org, actor, count, Some(units[0])).await;
        seed(&pool, w.org, actor, count, Some(units[1])).await;
        let mut tx = runtime.begin().await.unwrap();
        world::arm(&mut tx, w.org).await;
        let subject = load_access_subject(
            &mut tx,
            w.org,
            *actor.as_uuid(),
            console_kernel_core::Timestamp::now_utc(),
        )
        .await
        .unwrap();
        let grants = project(&subject);
        assert!(grants.errors.is_empty());
        tx.rollback().await.unwrap();
        let projected = Principal::new(
            actor,
            w.org,
            BTreeSet::from([Role::Member]),
            grants.branches,
        )
        .with_effective_feature_grants(grants.grants)
        .with_scope_grants(grants.scoped);
        let branch: Uuid = sqlx::query_scalar("SELECT w.default_branch_id FROM org_unit_placements p JOIN workplaces w ON w.org_id=p.org_id AND w.id=p.workplace_id WHERE p.org_id=$1 AND p.org_unit_id=$2")
            .bind(w.org.as_uuid()).bind(units[0]).fetch_one(&pool).await.unwrap();
        let mut principal = projected.clone();
        principal.roles = BTreeSet::from([Role::SuperAdmin]);
        principal.branch_scope =
            BranchScope::Branches(BTreeSet::from([console_kernel_core::BranchId::from_uuid(
                branch,
            )]));
        let now = sqlx::query_scalar("SELECT clock_timestamp()")
            .fetch_one(&pool)
            .await
            .unwrap();
        let queries = trail_queries::Queries::default();
        let actual = page(&runtime, &principal, query(now, 50), &Default::default())
            .with_subscriber(queries.clone())
            .await
            .unwrap();
        assert_eq!(actual.items.len(), count as usize);
        assert!(actual.items.iter().all(|i| i.kind == "hr_exit_confirm"));
        let allowed: BTreeSet<Uuid> =
            sqlx::query_scalar("SELECT id FROM employees WHERE org_id=$1 AND org_unit_id=$2")
                .bind(w.org.as_uuid())
                .bind(units[0])
                .fetch_all(&pool)
                .await
                .unwrap()
                .into_iter()
                .collect();
        assert!(
            actual
                .items
                .iter()
                .flat_map(|i| &i.links)
                .filter(|l| l.kind == "employee")
                .all(|l| allowed.contains(&l.id.parse().unwrap()))
        );
        counts.push(queries.statements().len());
        eprintln!(
            "hr_exit reported={count} statements={}",
            queries.statements().len()
        );
        if count == 20 {
            assert_eq!(
                counts[0], counts[1],
                "one batched Cedar scope check at 1 and 20 rows: {counts:?}"
            );
            assert_eq!(
                page(&runtime, &projected, query(now, 50), &Default::default())
                    .await
                    .unwrap()
                    .items
                    .len(),
                count as usize,
                "a department grant needs no legacy role or branch projection"
            );
        }
    }
}
