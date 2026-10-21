#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, Response, StatusCode, header};
use console_kernel_core::{BranchId, BranchScope, MessageId, OrgId, ThreadId, UserId};
use console_platform_auth::{JwtSettings, JwtVerifier};
use console_platform_authz::Principal;
use console_platform_realtime::sse::{SseConfig, SseState, router};
use console_platform_realtime::{
    PgRealtimeHub, RealtimeEvent, RealtimeHubConfig, RealtimeRestState, StreamFrom,
};
use futures::StreamExt;
use tokio::time::{Instant, timeout};
use tower::ServiceExt;

// A throwaway P-256 public key: only signature checks against it, never a signer.
const TEST_PUBLIC_KEY: &str = "-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAWL5IwSRdt1BsEvEJxDFq8Knw+kZ
xNUGIv+fQadym7l/0m8mK5uNrBz7un4xKGApDMk9W8l5pjqZPCZ+5SQ27g==
-----END PUBLIC KEY-----
";

fn verifier() -> JwtVerifier {
    JwtVerifier::from_es256_public_pem(
        JwtSettings {
            issuer: "console-test".into(),
            audience: "console-test".into(),
            access_token_ttl: time::Duration::minutes(15),
        },
        TEST_PUBLIC_KEY.as_bytes(),
    )
    .unwrap()
}

fn config(max_streams_per_user: usize) -> SseConfig {
    SseConfig {
        max_streams_per_user,
    }
}

fn state(hub: Arc<PgRealtimeHub>, max_streams_per_user: usize) -> SseState {
    SseState::new(
        RealtimeRestState::new(hub, Some(verifier()))
            .with_intervals(Duration::from_secs(60), Duration::from_secs(60)),
        config(max_streams_per_user),
    )
}

fn test_hub() -> Arc<PgRealtimeHub> {
    Arc::new(PgRealtimeHub::for_tests(RealtimeHubConfig::default()))
}

fn principal(user_id: UserId) -> Principal {
    Principal::new(
        user_id,
        OrgId::one(),
        std::collections::BTreeSet::new(),
        BranchScope::All,
    )
}

fn far() -> Instant {
    Instant::now() + Duration::from_secs(600)
}

async fn get(state: SseState, authorization: Option<&str>) -> Response<Body> {
    let mut request = Request::get("/api/v1/events");
    if let Some(value) = authorization {
        request = request.header(header::AUTHORIZATION, value);
    }
    router(state)
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap()
}

/// Reads frames until the body ends; panics if it is still open after 5 s.
async fn read_to_end(response: Response<Body>) -> String {
    let mut body = response.into_body().into_data_stream();
    let mut text = String::new();
    timeout(Duration::from_secs(5), async {
        while let Some(chunk) = body.next().await {
            text.push_str(std::str::from_utf8(&chunk.unwrap()).unwrap());
        }
    })
    .await
    .expect("stream must end");
    text
}

#[tokio::test]
async fn missing_or_non_bearer_authorization_is_401() {
    let missing = get(state(test_hub(), 10), None).await;
    assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);

    let basic = get(state(test_hub(), 10), Some("Basic dXNlcjpwYXNz")).await;
    assert_eq!(basic.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_bearer_that_fails_verification_is_401_before_any_db_read() {
    // A lazy pool never connects: the token is rejected before the lookup.
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://unreachable.invalid/none")
        .unwrap();
    let hub = Arc::new(PgRealtimeHub::new(pool, RealtimeHubConfig::default()));

    let response = get(state(hub, 10), Some("Bearer not.a.jwt")).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn the_stream_ends_at_the_bearer_deadline_with_sse_headers() {
    let sse = state(test_hub(), 10);
    let response = sse
        .stream_for_test(
            principal(UserId::new()),
            Instant::now() + Duration::from_millis(50),
            StreamFrom::default(),
        )
        .await;

    assert_eq!(response.status(), StatusCode::OK);
    let headers = response.headers();
    assert_eq!(headers[header::CONTENT_TYPE], "text/event-stream");
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    assert_eq!(headers["x-accel-buffering"], "no");
    assert_eq!(read_to_end(response).await, "retry: 3000\n\n");
}

#[tokio::test]
async fn one_stream_over_the_per_user_cap_is_429_and_a_closed_stream_frees_its_place() {
    let hub = test_hub();
    let sse = state(Arc::clone(&hub), 2);
    let user = UserId::new();

    let first = sse
        .stream_for_test(principal(user), far(), StreamFrom::default())
        .await;
    let second = sse
        .stream_for_test(principal(user), far(), StreamFrom::default())
        .await;
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(second.status(), StatusCode::OK);

    let over = sse
        .stream_for_test(principal(user), far(), StreamFrom::default())
        .await;
    assert_eq!(over.status(), StatusCode::TOO_MANY_REQUESTS);
    let other_user = sse
        .stream_for_test(principal(UserId::new()), far(), StreamFrom::default())
        .await;
    assert_eq!(other_user.status(), StatusCode::OK, "the cap is per user");
    assert_eq!(hub.connection_count().await, 3);

    drop(first);
    let again = sse
        .stream_for_test(principal(user), far(), StreamFrom::default())
        .await;
    assert_eq!(again.status(), StatusCode::OK);
    timeout(Duration::from_secs(5), async {
        while hub.connection_count().await != 3 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("a dropped stream removes its hub slot");
}

#[tokio::test]
async fn without_a_database_a_cursor_opens_the_stream_live() {
    let sse = state(test_hub(), 1);
    let from = StreamFrom {
        last_message_id: Some(MessageId::new()),
        last_event_id: Some(7),
    };
    let response = sse
        .stream_for_test(
            principal(UserId::new()),
            Instant::now() + Duration::from_millis(50),
            from,
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(read_to_end(response).await, "retry: 3000\n\n");
}

#[tokio::test]
async fn an_idle_stream_sends_heartbeat_comments() {
    let hub = test_hub();
    let sse = SseState::new(
        RealtimeRestState::new(hub, Some(verifier()))
            .with_intervals(Duration::from_millis(20), Duration::from_secs(60)),
        config(10),
    );
    let response = sse
        .stream_for_test(
            principal(UserId::new()),
            Instant::now() + Duration::from_millis(150),
            StreamFrom::default(),
        )
        .await;
    let body = read_to_end(response).await;
    assert!(body.starts_with("retry: 3000\n\n"), "{body}");
    assert!(body.matches(":\n\n").count() >= 2, "heartbeats: {body:?}");
}

#[tokio::test]
async fn hub_shutdown_ends_the_body() {
    let hub = test_hub();
    let sse = state(Arc::clone(&hub), 10);
    let response = sse
        .stream_for_test(principal(UserId::new()), far(), StreamFrom::default())
        .await;
    assert_eq!(response.status(), StatusCode::OK);

    hub.shutdown().await;
    assert_eq!(read_to_end(response).await, "retry: 3000\n\n");
}

#[tokio::test]
async fn an_event_that_cannot_be_re_read_ends_the_body_without_a_frame() {
    let hub = test_hub();
    let sse = state(Arc::clone(&hub), 10);
    let response = sse
        .stream_for_test(principal(UserId::new()), far(), StreamFrom::default())
        .await;

    // The hint reaches the slot, but the authorized re-read has no database.
    hub.dispatch_local_for_test(
        OrgId::one(),
        RealtimeEvent::MessageAcked {
            message_id: MessageId::new(),
            thread_id: ThreadId::new(),
            branch_id: BranchId::new(),
            ack_count: 1,
        },
    )
    .await
    .unwrap();
    assert_eq!(read_to_end(response).await, "retry: 3000\n\n");
}
