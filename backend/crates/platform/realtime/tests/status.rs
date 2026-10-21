#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use axum::body::to_bytes;
use console_platform_realtime::{PgRealtimeHub, status::heartbeat};
use sqlx::PgPool;
use std::sync::Arc;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn status_heartbeat_proves_real_listener_and_never_sends_tenant_frames(pool: PgPool) {
    let hub = Arc::new(PgRealtimeHub::new(pool, Default::default()));
    assert!(!hub.status_heartbeat().await);
    let bridge = hub.clone().start_postgres_listener().await.unwrap();
    let response = heartbeat(hub.clone()).await;
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(
        &to_bytes(response.into_body(), 1024).await.unwrap()[..],
        b": heartbeat\n\n"
    );
    bridge.shutdown();
    for _ in 0..100 {
        tokio::task::yield_now().await;
        if !hub.status_heartbeat().await {
            return;
        }
    }
    panic!("stopped listener still answered a fresh ping");
}
