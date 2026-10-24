//! `GET /api/v1/events` after the session ends (BW-24 / INF-03): a signed-out
//! (or idle-ended) refresh family is refused at connect, and a stream opened
//! before the sign-out ends at its next frame instead of delivering it. The
//! stream itself never moves the session: it carries no `X-Last-Interaction`
//! (apps' events.ts) and the handler writes nothing back.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::time::Duration as StdDuration;

use axum::body::Body;
use axum::http::{Request, Response, StatusCode, header};
use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext};
use console_platform_auth::{
    AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier, RefreshTokenStore,
};
use console_platform_db::{DbError, with_audits};
use console_platform_realtime::sse::{SseConfig, SseState, router};
use console_platform_realtime::{PgRealtimeHub, RealtimeHubConfig, RealtimeRestState};
use console_platform_test_support::{runtime_role_pool, seed_branch, seed_user};
use futures::StreamExt;
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use tokio::time::timeout;
use tower::ServiceExt;

async fn get(sse: &SseState, token: &str) -> Response<Body> {
    let request = Request::get("/api/v1/events")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    router(sse.clone()).oneshot(request).await.unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_signed_out_session_is_refused_and_its_open_stream_ends_unsent(owner: PgPool) {
    console_platform_test_support::seed_consent_documents(&owner).await;
    let org = OrgId::one();
    let branch = seed_branch(&owner, "rt-sse-out", "rt-sse-out").await;
    let user = seed_user(&owner, "Reader", "SUPER_ADMIN", branch).await;
    let runtime = runtime_role_pool(&owner).await;
    let key = SigningKey::random(&mut OsRng);
    let private = key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public = key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let settings = JwtSettings {
        issuer: "rt-sse-out".into(),
        audience: "rt-sse-out".into(),
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
    let input = AccessTokenInput {
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
    };
    let token = issuer
        .issue_session_access_token(
            input.clone(),
            None,
            vec![],
            family.family_id,
            family.expires_at,
        )
        .unwrap();
    let refs = {
        let mut tx = owner.begin().await.unwrap();
        let refs = console_platform_request_context::privacy::current_references_in_tx(&mut tx)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        serde_json::to_value(refs).unwrap()
    };
    sqlx::query("UPDATE auth_refresh_token_families SET privacy_acceptance=$2 WHERE id=$1")
        .bind(family.family_id)
        .bind(&refs)
        .execute(&owner)
        .await
        .unwrap();
    let protected = console_platform_request_context::with_request_context(
        axum::Router::new().route(
            "/protected",
            axum::routing::get(|| async { "personal data" }),
        ),
        Some(verifier.clone()),
        runtime.clone(),
    );
    let request = || {
        Request::get("/protected")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap()
    };
    assert_eq!(
        protected.clone().oneshot(request()).await.unwrap().status(),
        StatusCode::OK
    );
    let hub = Arc::new(PgRealtimeHub::new(
        runtime.clone(),
        RealtimeHubConfig::default(),
    ));
    let _bridge = Arc::clone(&hub).start_postgres_listener().await.unwrap();
    // Recheck on every frame, so the test does not wait the 60 s default.
    let sse = SseState::new(
        RealtimeRestState::new(hub, Some(verifier))
            .with_intervals(StdDuration::from_secs(60), StdDuration::ZERO),
        SseConfig::default(),
    );

    // Signed in: the stream opens.
    let open = get(&sse, &token).await;
    assert_eq!(open.status(), StatusCode::OK);
    let mut body = open.into_body().into_data_stream();
    let mut text = String::new();
    timeout(StdDuration::from_secs(5), async {
        while !text.contains("event: hello") {
            let chunk = body.next().await.expect("open body").unwrap();
            text.push_str(std::str::from_utf8(&chunk).unwrap());
        }
    })
    .await
    .expect("hello while signed in");

    // A second already-open tab is interrupted without a request or navigation too.
    let other = get(&sse, &token).await;
    let mut other_body = other.into_body().into_data_stream();
    timeout(StdDuration::from_secs(5), async {
        while let Some(chunk) = other_body.next().await {
            if std::str::from_utf8(&chunk.unwrap())
                .unwrap()
                .contains("event: hello")
            {
                break;
            }
        }
    })
    .await
    .unwrap();
    // Future text is not required before its publication instant; no polling is needed at that instant.
    sqlx::query("INSERT INTO terms_documents (version,kind,body,published_at) VALUES ('sse-next','service_terms','New required text',clock_timestamp()+interval '1 second')")
        .execute(&owner).await.unwrap();
    for stream in [&mut body, &mut other_body] {
        let mut publication = String::new();
        timeout(StdDuration::from_secs(5), async {
            loop {
                let chunk = stream.next().await.unwrap().unwrap();
                publication.push_str(std::str::from_utf8(&chunk).unwrap());
                if publication.contains(r#""accepted":false"#) {
                    break;
                }
            }
        })
        .await
        .expect("publication interrupts every open tab");
        assert!(
            publication.contains("event: privacy_consent"),
            "{publication}"
        );
    }
    let refused = protected.clone().oneshot(request()).await.unwrap();
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    let bytes = axum::body::to_bytes(refused.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["error"]["code"],
        "privacy_consent_required"
    );
    // A reconnect refuses the stale session even if it missed the publication hint.
    let reopened = get(&sse, &token).await;
    assert_eq!(reopened.status(), StatusCode::FORBIDDEN);
    let bytes = axum::body::to_bytes(reopened.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["error"]["code"],
        "privacy_consent_required"
    );
    // Signed out (an idle timeout ends the family the same way): the
    // still-unexpired access token no longer opens a stream.
    sqlx::query("UPDATE auth_refresh_token_families SET revoked_at=now() WHERE id=$1")
        .bind(family.family_id)
        .execute(&owner)
        .await
        .unwrap();
    assert_eq!(get(&sse, &token).await.status(), StatusCode::UNAUTHORIZED);

    // The stream opened before the sign-out delivers nothing more: the next
    // change re-resolves the session and ends the body without the frame.
    let audit = AuditEvent::new(
        None,
        AuditAction::new("legal_entity.revise").unwrap(),
        "legal_entity",
        uuid::Uuid::new_v4().to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org);
    with_audits::<_, _, DbError>(&owner, org, move |_tx| {
        Box::pin(async move { Ok(((), vec![audit])) })
    })
    .await
    .unwrap();
    text.clear();
    timeout(StdDuration::from_secs(5), async {
        while let Some(chunk) = body.next().await {
            text.push_str(std::str::from_utf8(&chunk.unwrap()).unwrap());
        }
    })
    .await
    .expect("the signed-out stream ends");
    assert!(!text.contains("event: change"), "{text}");
}
