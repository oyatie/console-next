// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

fn app(w: &World) -> Router {
    let store = Arc::new(FakeStore {
        size: Mutex::new(Some(2048)),
    });
    router(
        w.hr.clone(),
        Some(PhotoStore {
            store,
            bucket: "primary".into(),
        }),
    )
    .layer(Extension(w.hr(w.hr_one)))
}

async fn exited(pool: &PgPool, w: &World) {
    sqlx::query(
        "UPDATE employees SET employment_status = 'EXITED', exit_date = '2026-10-10' \
         WHERE org_id = $1 AND id = $2",
    )
    .bind(w.org)
    .bind(w.in_a)
    .execute(pool)
    .await
    .unwrap();
}

async fn issue(app: &Router, uploads: &str) -> (StatusCode, Value) {
    call(
        app,
        Method::POST,
        uploads,
        Some(json!({ "content_type": "image/jpeg", "byte_size": 2048 })),
    )
    .await
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn former_employee_photo_upload_issue_is_read_only(pool: PgPool) {
    let w = world(&pool).await;
    let app = app(&w);
    let uploads = format!("/api/v1/employees/{}/photo-uploads", w.in_a);
    let (status, issued) = issue(&app, &uploads).await;
    assert_eq!(status, StatusCode::OK, "{issued}");

    exited(&pool, &w).await;
    let (status, refused) = issue(&app, &uploads).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["error"]["code"], "employee_exited_read_only");
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM employee_photo_uploads WHERE org_id = $1 AND employee_id = $2",
    )
    .bind(w.org)
    .bind(w.in_a)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 1, "refusal must not issue another upload");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn former_employee_photo_upload_confirmation_is_read_only(pool: PgPool) {
    let w = world(&pool).await;
    let app = app(&w);
    let uploads = format!("/api/v1/employees/{}/photo-uploads", w.in_a);
    let (status, issued) = issue(&app, &uploads).await;
    assert_eq!(status, StatusCode::OK, "{issued}");
    let confirm = format!(
        "{uploads}/{}/confirm",
        issued["upload_id"].as_str().unwrap()
    );
    let (status, confirmed) = call(&app, Method::POST, &confirm, None).await;
    assert_eq!(status, StatusCode::OK, "{confirmed}");
    assert_eq!(confirmed["confirmed"], true);

    let (status, pending) = issue(&app, &uploads).await;
    assert_eq!(status, StatusCode::OK, "{pending}");
    let upload_id = Uuid::parse_str(pending["upload_id"].as_str().unwrap()).unwrap();
    let confirm = format!("{uploads}/{upload_id}/confirm");
    exited(&pool, &w).await;
    let (status, refused) = call(&app, Method::POST, &confirm, None).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["error"]["code"], "employee_exited_read_only");
    let confirmed: bool = sqlx::query_scalar(
        "SELECT confirmed_at IS NOT NULL FROM employee_photo_uploads \
         WHERE org_id = $1 AND employee_id = $2 AND id = $3",
    )
    .bind(w.org)
    .bind(w.in_a)
    .bind(upload_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!confirmed, "refusal must leave the upload unconfirmed");
}
