// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

async fn snapshot(pool: &PgPool, w: &World) -> Value {
    sqlx::query_scalar(
        "SELECT jsonb_build_array( \
         (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM employee_exit_cases c WHERE org_id=$1), \
         (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM employees e WHERE org_id=$1), \
         (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM employee_lifecycle_events l WHERE org_id=$1), \
         (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM audit_events a WHERE org_id=$1))",
    )
    .bind(w.org)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn refuse_cancel(pool: &PgPool, status: &str, future: bool) {
    let w = live(pool).await;
    let on = console_hr_adapter_postgres::clock::today_kst()
        + Duration::days(if future { 10 } else { -1 });
    let c = report(&w, w.in_a, Some("PERSONAL"), &on.to_string())
        .await
        .unwrap();
    let confirmed = confirm(&w, &c, json!({})).await.unwrap();
    let expected_event = if future { "SCHEDULED" } else { "APPLIED" };
    assert_eq!(confirmed["exit_event_state"], expected_event);
    if !future {
        let status: String =
            sqlx::query_scalar("SELECT employment_status FROM employees WHERE id=$1")
                .bind(w.in_a)
                .fetch_one(pool)
                .await
                .unwrap();
        assert_eq!(status, "EXITED");
    }
    let id = c["id"].as_str().unwrap().parse().unwrap();
    if status != "HR_CONFIRMED" {
        w.hr.confirm_exit_case(
            w.hr(w.hr_two),
            None,
            id,
            serde_json::from_value(json!({"hq_confirmation":true})).unwrap(),
        )
        .await
        .unwrap();
    }
    if matches!(status, "SETTLEMENT_READY" | "APPROVAL_DRAFTED") {
        sqlx::query("UPDATE employee_exit_cases SET status=$2 WHERE id=$1")
            .bind(id)
            .bind(status)
            .execute(pool)
            .await
            .unwrap();
    }
    let before = snapshot(pool, &w).await;
    let error =
        w.hr.close_exit_case(
            w.hr(w.hr_one),
            id,
            serde_json::from_value(json!({"reason":"잘못 보고"})).unwrap(),
            "CANCELLED",
        )
        .await
        .unwrap_err();
    assert_eq!(
        (error.status.as_u16(), error.code),
        (409, "exit_cancel_after_hr_confirmation")
    );
    assert_eq!(snapshot(pool, &w).await, before, "refusal writes nothing");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn reported_can_be_cancelled_by_the_reporter(pool: PgPool) {
    let w = live(&pool).await;
    let reporter = w.admin(w.admin_a, w.branch_a);
    let (_, c) = w.hr.report_exit_case(
        reporter.clone(),
        Uuid::new_v4().to_string(),
        serde_json::from_value(json!({"employee_id":w.in_a,"effective_exit_date":"2026-10-10","site_manager_note":"퇴직 보고","exit_reason_code":"PERSONAL"})).unwrap(),
    ).await.unwrap();
    let closed =
        w.hr.close_exit_case(
            reporter,
            c["id"].as_str().unwrap().parse().unwrap(),
            serde_json::from_value(json!({"reason":"보고 회수"})).unwrap(),
            "CANCELLED",
        )
        .await
        .unwrap();
    assert_eq!(closed.status, "CANCELLED");
    assert_eq!(count(&pool, "employee_lifecycle_events", &w).await, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn hr_confirmed_scheduled_cannot_be_cancelled(pool: PgPool) {
    refuse_cancel(&pool, "HR_CONFIRMED", true).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn exited_cannot_be_cancelled(pool: PgPool) {
    refuse_cancel(&pool, "HR_CONFIRMED", false).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn hq_confirmed_cannot_be_cancelled(pool: PgPool) {
    refuse_cancel(&pool, "HQ_CONFIRMED", false).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn hq_confirmed_scheduled_cannot_be_cancelled(pool: PgPool) {
    refuse_cancel(&pool, "HQ_CONFIRMED", true).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn settlement_ready_cannot_be_cancelled(pool: PgPool) {
    refuse_cancel(&pool, "SETTLEMENT_READY", false).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn approval_drafted_cannot_be_cancelled(pool: PgPool) {
    refuse_cancel(&pool, "APPROVAL_DRAFTED", false).await;
}
