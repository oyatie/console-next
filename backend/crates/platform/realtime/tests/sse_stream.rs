//! RT-5 against Postgres: a committed audited write reaches an open
//! `GET /api/v1/events` body as an id-only `change` frame (contract.md).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::Response;
use console_kernel_core::{AuditAction, AuditEvent, BranchScope, OrgId, TraceContext, UserId};
use console_platform_authz::{EffectiveFeatureGrant, Feature, PermissionLevel, Principal};
use console_platform_db::{DbError, with_audits};
use console_platform_realtime::sse::{SseConfig, SseState};
use console_platform_realtime::{PgRealtimeHub, RealtimeHubConfig, RealtimeRestState, StreamFrom};
use console_platform_test_support::runtime_role_pool;
use futures::StreamExt;
use sqlx::PgPool;
use time::OffsetDateTime;
use tokio::time::{Instant, timeout};

/// Reads the body until `needle` and the end of its frame have arrived;
/// panics after 5 s.
async fn read_until(body: &mut axum::body::BodyDataStream, text: &mut String, needle: &str) {
    let done = |text: &str| {
        text.split(needle)
            .nth(1)
            .is_some_and(|f| f.contains("\n\n"))
    };
    timeout(Duration::from_secs(5), async {
        while !done(text) {
            let chunk = body.next().await.expect("open body").unwrap();
            text.push_str(std::str::from_utf8(&chunk).unwrap());
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{needle:?} not in {text:?}"));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_committed_write_reaches_the_open_stream_as_an_id_only_change(pool: PgPool) {
    let org = OrgId::one();
    let hub = Arc::new(PgRealtimeHub::new(
        runtime_role_pool(&pool).await,
        RealtimeHubConfig::default(),
    ));
    let _bridge = Arc::clone(&hub).start_postgres_listener().await.unwrap();
    let sse = SseState::new(RealtimeRestState::new(hub, None), SseConfig::default());
    let grant = EffectiveFeatureGrant::new(
        Feature::OrgChangeRead,
        PermissionLevel::Allow,
        BranchScope::All,
    );
    let reader = Principal::new(UserId::new(), org, BTreeSet::new(), BranchScope::All)
        .with_effective_feature_grants(vec![grant]);
    let response: Response<Body> = sse
        .stream_for_test(
            reader,
            Instant::now() + Duration::from_secs(30),
            StreamFrom::default(),
        )
        .await;
    let mut body = response.into_body().into_data_stream();
    let mut text = String::new();
    read_until(&mut body, &mut text, "event: hello\nid: 0\n").await;

    let entity = uuid::Uuid::new_v4().to_string();
    let audit = AuditEvent::new(
        None,
        AuditAction::new("legal_entity.revise").unwrap(),
        "legal_entity",
        entity.clone(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org)
    .with_snapshots(None, Some(serde_json::json!({ "name": "주식회사 비밀" })));
    with_audits::<_, _, DbError>(&pool, org, move |_tx| {
        Box::pin(async move { Ok(((), vec![audit])) })
    })
    .await
    .unwrap();

    read_until(&mut body, &mut text, "event: change\n").await;
    let frame = text.split("event: change\n").nth(1).unwrap();
    let id_line = frame.lines().next().unwrap();
    assert!(
        id_line
            .strip_prefix("id: ")
            .unwrap()
            .parse::<i64>()
            .unwrap()
            > 0,
        "{frame}"
    );
    let data: serde_json::Value = serde_json::from_str(
        frame
            .lines()
            .nth(1)
            .unwrap()
            .strip_prefix("data: ")
            .unwrap(),
    )
    .unwrap();
    assert_eq!(data["type"], "legal_entity");
    assert_eq!(data["id"], entity);
    assert!(data["ver"].is_null());
    assert!(data["at"].as_str().unwrap().ends_with('Z'));
    assert!(!text.contains("비밀"), "no values ride the stream: {text}");
}
