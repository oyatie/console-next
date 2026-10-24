//! `/api/v1/ws?changes=true` over a real socket, live Postgres and the
//! non-owner runtime role: the same change frames as SSE, plus the server
//! ping that keeps an idle socket alive through the edge.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::time::Duration as StdDuration;

use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext};
use console_platform_auth::{
    AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier, RefreshTokenStore,
};
use console_platform_db::{DbError, with_audits};
use console_platform_realtime::{PgRealtimeHub, RealtimeHubConfig, RealtimeRestState};
use console_platform_test_support::{seed_branch, seed_user};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::Value;
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;

async fn runtime_pool(owner: &PgPool) -> PgPool {
    let password = std::env::var("CONSOLE_TEST_RUNTIME_PASSWORD")
        .expect("disposable console_rt password must be supplied");
    let options = owner.connect_options().as_ref().clone();
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(4)
        .connect_with(options.username("console_rt").password(&password))
        .await
        .unwrap()
}

/// One server frame: (opcode, payload).
async fn frame(stream: &mut TcpStream) -> (u8, Vec<u8>) {
    timeout(StdDuration::from_secs(5), async {
        let first = stream.read_u8().await.unwrap();
        let second = stream.read_u8().await.unwrap();
        let size = match second & 0x7f {
            126 => u64::from(stream.read_u16().await.unwrap()),
            127 => stream.read_u64().await.unwrap(),
            n => u64::from(n),
        };
        let mut bytes = vec![0; usize::try_from(size).unwrap()];
        stream.read_exact(&mut bytes).await.unwrap();
        (first & 0xf, bytes)
    })
    .await
    .expect("a frame within 5 s")
}

async fn json(stream: &mut TcpStream) -> Value {
    let (opcode, bytes) = frame(stream).await;
    assert_eq!(opcode, 1, "a text frame");
    serde_json::from_slice(&bytes).unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_change_subscribed_socket_gets_hello_change_and_pings(owner: PgPool) {
    let org = OrgId::one();
    let branch = seed_branch(&owner, "rt-ws", "rt-ws").await;
    let user = seed_user(&owner, "Reader", "SUPER_ADMIN", branch).await;
    let runtime = runtime_pool(&owner).await;

    let key = SigningKey::random(&mut OsRng);
    let private = key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public = key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let settings = JwtSettings {
        issuer: "rt-ws".into(),
        audience: "rt-ws".into(),
        access_token_ttl: Duration::minutes(10),
    };
    let issuer =
        JwtIssuer::from_es256_pem(settings.clone(), private.as_bytes(), public.as_bytes()).unwrap();
    let verifier = JwtVerifier::from_es256_public_pem(settings, public.as_bytes()).unwrap();
    let now = OffsetDateTime::now_utc();
    let family = RefreshTokenStore
        .issue_family(&runtime, *user.as_uuid(), org, now, Duration::hours(1))
        .await
        .unwrap();
    let token = issuer
        .issue_session_access_token(
            AccessTokenInput {
                subject: user,
                org_id: org,
                roles: vec!["SUPER_ADMIN".into()],
                branches: vec![branch],
                platform: false,
                support: None,
                read_only: false,
                display_name: None,
                feature_grants: vec![],
                authz_subject_version: 0,
                authz_policy_version: 0,
                session_generation: 0,
                issued_at: now,
            },
            None,
            vec![],
            family.family_id,
            family.expires_at,
        )
        .unwrap();

    let hub = Arc::new(PgRealtimeHub::new(
        runtime.clone(),
        RealtimeHubConfig::default(),
    ));
    let _bridge = Arc::clone(&hub).start_postgres_listener().await.unwrap();
    let state = RealtimeRestState::new(hub, Some(verifier))
        .with_intervals(StdDuration::from_secs(1), StdDuration::from_secs(60));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, console_platform_realtime::router(state))
            .await
            .unwrap();
    });

    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream
        .write_all(
            format!(
                "GET /api/v1/ws?changes=true HTTP/1.1\r\nHost: {addr}\r\nConnection: Upgrade\r\n\
                 Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n\
                 Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nAuthorization: Bearer {token}\r\n\r\n"
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        header.push(stream.read_u8().await.unwrap());
    }
    assert!(
        String::from_utf8(header)
            .unwrap()
            .starts_with("HTTP/1.1 101")
    );

    let hello = json(&mut stream).await;
    assert_eq!(
        (hello["type"].as_str(), hello["id"].as_str()),
        (Some("hello"), Some("0"))
    );

    let entity = uuid::Uuid::new_v4().to_string();
    let audit = AuditEvent::new(
        None,
        AuditAction::new("legal_entity.revise").unwrap(),
        "legal_entity",
        entity.clone(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org);
    with_audits::<_, _, DbError>(&owner, org, move |_tx| {
        Box::pin(async move { Ok(((), vec![audit])) })
    })
    .await
    .unwrap();
    let change = json(&mut stream).await;
    assert_eq!(change["type"], "change");
    assert!(change["id"].as_str().unwrap().parse::<i64>().unwrap() > 0);
    assert_eq!(change["data"]["type"], "legal_entity");
    assert_eq!(change["data"]["id"], entity);

    let (opcode, _) = frame(&mut stream).await;
    assert_eq!(opcode, 9, "an idle socket gets a server ping");
    server.abort();
}
