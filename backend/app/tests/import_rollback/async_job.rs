// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use axum::body::{Body, to_bytes};
use http::Request;
use tower::ServiceExt;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn prefer_async_accepts_a_tracked_rollback_and_emits_completion(pool: PgPool) {
    let i = import_fixture::importer(pool.clone()).await;
    let run = applied_run(&i).await;
    let preview =
        i.f.hr
            .preview_import_rollback(i.f.principal.clone(), run)
            .await
            .unwrap();
    let keys = keys();
    let service = router(&pool, &keys).await;
    let token = token(&pool, &keys, i.org(), i.f.principal.user_id, "SUPER_ADMIN").await;
    let request = Request::builder()
        .method("POST")
        .uri(format!("/api/v1/employee-import-runs/{run}/rollback"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .header("Idempotency-Key", Uuid::new_v4().to_string())
        .header("Prefer", "respond-async")
        .body(Body::from(
            serde_json::json!({"preview_digest":preview.preview_digest,"acknowledged":true})
                .to_string(),
        ))
        .unwrap();
    let response = service.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let body: serde_json::Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body["status"], "ROLLBACK_RUNNING");
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let current = i.f.hr.import_run(i.f.principal.clone(), run).await.unwrap();
            if current.status == "ROLLED_BACK" {
                break;
            }
            assert_eq!(current.status, "ROLLBACK_RUNNING");
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(
        rollback_frames(&i, run)
            .await
            .contains(&"data_import.rollback".to_owned())
    );
}
