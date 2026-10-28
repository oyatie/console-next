// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn former_employee_cannot_issue_photo_upload(pool: PgPool) {
    let w = world(&pool).await;
    sqlx::query(
        "UPDATE employees SET employment_status='EXITED', exit_date='2026-10-10' WHERE id=$1",
    )
    .bind(w.in_a)
    .execute(&pool)
    .await
    .unwrap();
    let request =
        serde_json::from_value(json!({ "content_type": "image/jpeg", "byte_size": 1024 })).unwrap();
    let error =
        w.hr.issue_photo_upload(w.hr(w.hr_one), w.in_a, request)
            .await
            .unwrap_err();
    assert_eq!(
        (error.status.as_u16(), error.code),
        (409, "employee_exited_read_only")
    );
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM employee_photo_uploads WHERE employee_id=$1")
            .bind(w.in_a)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn former_employee_cannot_confirm_photo_upload_issued_while_active(pool: PgPool) {
    let w = world(&pool).await;
    let request =
        serde_json::from_value(json!({ "content_type": "image/jpeg", "byte_size": 1024 })).unwrap();
    let upload =
        w.hr.issue_photo_upload(w.hr(w.hr_one), w.in_a, request)
            .await
            .unwrap();
    assert!(!upload.confirmed);
    let id = upload.upload_id;
    sqlx::query(
        "UPDATE employees SET employment_status='EXITED', exit_date='2026-10-10' WHERE id=$1",
    )
    .bind(w.in_a)
    .execute(&pool)
    .await
    .unwrap();
    let error =
        w.hr.confirm_photo_upload(w.hr(w.hr_one), upload)
            .await
            .unwrap_err();
    assert_eq!(
        (error.status.as_u16(), error.code),
        (409, "employee_exited_read_only")
    );
    let confirmed: bool = sqlx::query_scalar(
        "SELECT confirmed_at IS NOT NULL FROM employee_photo_uploads WHERE id=$1",
    )
    .bind(id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!confirmed);
}
