// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, dead_code)]
#[path = "emp_create/fixture.rs"]
mod fixture;
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn registration_writes_a_system_code_for_immediate_and_scheduled_onboard(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    for (key, hire) in [
        ("raw-immediate", "2026-09-01"),
        ("raw-scheduled", "2099-01-01"),
    ] {
        let mut body = f.body(key, "REGULAR");
        body.hire_date = Some(hire.into());
        let employee = f.create(body).await.unwrap();
        let (code, comment): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT to_jsonb(e)->>'comment_code', comment FROM employee_lifecycle_events e WHERE employee_id=$1 AND event_type='ONBOARD'",
        ).bind(employee.employee.id).fetch_one(&pool).await.unwrap();
        assert_eq!(code.as_deref(), Some("created_by_registration"));
        assert!(comment.as_deref().is_none_or(str::is_empty));
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn legacy_registration_command_also_writes_only_the_catalog_code(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let employee = uuid::Uuid::new_v4();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(f.principal.org_id.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("SELECT * FROM leave_api.create_employee($1,$2,'RAW-001','김등록','Co','REGULAR','+821012345678','부서','사원','본사',$3,NULL,'raw-legacy',repeat('a',64),$4,'00000000000000000000000000000001','0000000000000001')")
        .bind(f.principal.org_id.as_uuid()).bind(employee).bind(f.branch)
        .bind(f.principal.user_id.as_uuid()).execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    let (code, comment): (Option<String>, Option<String>) = sqlx::query_as(
        "SELECT to_jsonb(e)->>'comment_code', comment FROM employee_lifecycle_events e WHERE employee_id=$1 AND event_type='ONBOARD'",
    ).bind(employee).fetch_one(&pool).await.unwrap();
    assert_eq!(code.as_deref(), Some("created_by_registration"));
    assert!(comment.as_deref().is_none_or(str::is_empty));
}
