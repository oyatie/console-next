//! UX-R1 PLACEMENT (org-19, worst-case-32): the legacy 소속 지점 is the
//! 사업장's own branch. A registration or a one-click 「소속 지점 지정」 that
//! names another branch is refused (422 `home_branch_not_workplace`) and
//! writes nothing.

use console_hr_adapter_postgres::directory::types::SetEmployeeHomeBranchRequest;
use sqlx::PgPool;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

use crate::import_fixture::importer;
use crate::register;

/// 본사 (backed by the fixture's branch) and 공장 (another branch), with a
/// 부서 under 본사's SITE unit: `(공장's branch, 부서)`.
async fn two_sites(owner: &PgPool, f: &crate::fixture::Fixture) -> (Uuid, Uuid) {
    let o = *f.principal.org_id.as_uuid();
    let user = *f.principal.user_id.as_uuid();
    let other: Uuid = sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) \
         SELECT region_id, '공장', org_id FROM branches WHERE id = $1 RETURNING id",
    )
    .bind(f.branch)
    .fetch_one(owner)
    .await
    .unwrap();
    let (entity, hq, plant, dept) = (
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    );
    let branch = f.branch;
    let site = f.unit;
    let sql = format!(
        "INSERT INTO legal_entities (org_id, id, needs_confirmation, created_change_mode) \
         VALUES ('{o}', '{entity}', true, 'MIGRATION'); \
         INSERT INTO workplaces (org_id, id, legal_entity_id, needs_confirmation, created_change_mode, default_branch_id) \
         VALUES ('{o}', '{hq}', '{entity}', true, 'MIGRATION', '{branch}'), \
                ('{o}', '{plant}', '{entity}', true, 'MIGRATION', '{other}'); \
         INSERT INTO org_unit_placements (org_id, org_unit_id, legal_entity_id, workplace_id, \
         represents_workplace, valid_from, change_mode, command_id) VALUES ('{o}', '{site}', \
         '{entity}', '{hq}', true, '2026-01-01', 'MIGRATION', gen_random_uuid()); \
         INSERT INTO org_units (org_id, id) VALUES ('{o}', '{dept}'); \
         INSERT INTO org_unit_revisions (org_id, org_unit_id, version, command_id, actor_id, \
         payload_digest, attributes, receipt) VALUES ('{o}', '{dept}', 1, gen_random_uuid(), \
         '{user}', decode(repeat('ab', 32), 'hex'), \
         '{{\"kind\": \"department\", \"name\": \"인사팀\", \"parent_id\": \"{site}\"}}', '{{}}');"
    );
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    (other, dept)
}

async fn people(owner: &PgPool) -> (i64, i64) {
    sqlx::query_as(
        "SELECT (SELECT count(*) FROM employees), (SELECT count(*) FROM employment_assignments)",
    )
    .fetch_one(owner)
    .await
    .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_the_home_branch_never_contradicts_the_workplace(pool: PgPool) {
    let mut i = importer(pool.clone()).await;
    i.f.unit = sqlx::query_scalar("SELECT org_unit_id FROM org_unit_revisions WHERE org_id = $1 AND attributes->>'name' = 'site' ORDER BY version DESC LIMIT 1")
        .bind(*i.f.principal.org_id.as_uuid()).fetch_one(&pool).await.unwrap();
    let f = &i.f;
    let (other, dept) = two_sites(&pool, f).await;

    // Registration: the 부서 sits at 본사; 공장's branch is refused, nothing written.
    let before = people(&pool).await;
    let mut body = f.body("branch-1", "REGULAR");
    body.org_unit_id = Some(dept);
    body.home_branch_id = Some(other);
    let refused = register(f, body).await.unwrap_err();
    assert_eq!(
        (refused.status.as_u16(), refused.code),
        (422, "home_branch_not_workplace")
    );
    assert_eq!(people(&pool).await, before);

    // 본사's own branch registers.
    let mut body = f.body("branch-2", "REGULAR");
    body.org_unit_id = Some(dept);
    let (made, _) = register(f, body).await.unwrap();
    let id = made.employee.id;

    // The one click: another 사업장's branch is refused and changes nothing.
    let stamp = || async {
        let (branch, at): (Option<Uuid>, OffsetDateTime) =
            sqlx::query_as("SELECT home_branch_id, updated_at FROM employees WHERE id = $1")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();
        (branch, at)
    };
    let (branch, at) = stamp().await;
    let ask = |branch_id: Uuid| SetEmployeeHomeBranchRequest {
        branch_id,
        expected_updated_at: at.format(&Rfc3339).unwrap(),
    };
    let refused =
        f.hr.set_home_branch(f.principal.clone(), i.store.clone(), id, ask(other))
            .await
            .unwrap_err();
    assert_eq!(
        (refused.status.as_u16(), refused.code),
        (422, "home_branch_not_workplace")
    );
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE target_id = $1::text AND action = 'employee.home_branch_set'",
    )
    .bind(id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((stamp().await, audits), ((branch, at), 0));
    // Bypassing the service preflight still rechecks under the command's employee lock.
    let refused = console_platform_request_context::scope_org(f.principal.org_id, async {
        i.store
            .set_employee_home_branch(
                id,
                other,
                at,
                f.principal.user_id,
                console_kernel_core::TraceContext::generate(),
            )
            .await
    })
    .await
    .unwrap_err();
    let console_leave_adapter_postgres::PgLeaveError::Domain(refused) = refused else {
        panic!("expected branch refusal")
    };
    assert_eq!(refused.code, Some("home_branch_not_workplace"));
    assert_eq!(stamp().await, (branch, at));
    // The 사업장's own branch is accepted.
    let set =
        f.hr.set_home_branch(f.principal.clone(), i.store.clone(), id, ask(f.branch))
            .await
            .unwrap();
    assert_eq!(set.branch_id, f.branch);
}
