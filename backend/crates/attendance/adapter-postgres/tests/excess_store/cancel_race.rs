// SPDX-License-Identifier: LicenseRef-Proprietary
use super::store_support::{CANCEL, approval, code, runtime};
use super::support::world;
use sqlx::PgPool;
use tokio::time::{Duration, sleep, timeout};
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_concurrent_cancellation_cannot_become_an_approval_target(pool: PgPool) {
    let w = world(pool).await;
    let original = approval(&w).await;
    let mut first = runtime(&w).await;
    let cancellation: Uuid = sqlx::query_scalar(CANCEL)
        .bind(original)
        .fetch_one(&mut *first)
        .await
        .unwrap();
    let mut second = runtime(&w).await;
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *second)
        .await
        .unwrap();
    let attempted = tokio::spawn(async move {
        let result = sqlx::query_scalar::<_, Uuid>("INSERT INTO attendance_overtime_approvals \
            (org_id, employee_id, work_date, from_minutes, to_minutes, approver_employee_id, method_code, evidence, recorded_by, cancels_id) \
            SELECT org_id, employee_id, work_date, from_minutes, to_minutes, approver_employee_id, method_code, evidence, recorded_by, $2 \
            FROM attendance_overtime_approvals WHERE id=$1 RETURNING id")
            .bind(original).bind(cancellation)
            .fetch_one(&mut *second)
            .await;
        second.rollback().await.unwrap();
        result
    });
    timeout(Duration::from_secs(10), async {
        loop {
            let waiting: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock')")
                .bind(pid).fetch_one(&w.owner).await.unwrap();
            if waiting || attempted.is_finished() { break; }
            sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("second writer reaches the foreign key check");
    first.commit().await.unwrap();
    let result = timeout(Duration::from_secs(10), attempted)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(code(result.unwrap_err()), "23503");
}
