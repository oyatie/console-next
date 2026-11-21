// SPDX-License-Identifier: LicenseRef-Proprietary
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use console_ops_application::{Alert, AlertState, AlertStatus};
use console_ops_rest::router;
use futures::StreamExt;
use time::OffsetDateTime;
use tower::ServiceExt;

mod support;
use support::{
    AUD, ISSUER, JwtSigner, OPERATOR_EMAIL, READ_HOME_ONLY_EMAIL, UNKNOWN_EMAIL, make_state,
};

type TestResult = Result<(), Box<dyn std::error::Error>>;

async fn read_sse_until(body: Body, needle: &str) -> Result<String, Box<dyn std::error::Error>> {
    let mut stream = body.into_data_stream();
    let mut out = Vec::new();
    let deadline = tokio::time::sleep(Duration::from_millis(500));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => break,
            next = stream.next() => {
                match next {
                    Some(Ok(chunk)) => {
                        out.extend_from_slice(&chunk);
                        if String::from_utf8_lossy(&out).contains(needle) {
                            break;
                        }
                    }
                    _ => break,
                }
            }
        }
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

#[tokio::test]
async fn sse_refuses_ungranted_operators_and_filters_and_resumes_with_resync() -> TestResult {
    let signer = JwtSigner::generate()?;
    let (state, eval, sources, shutdown_tx) = make_state(&signer).await?;
    // Short timeout (20ms) proves SSE escapes TimeoutLayer!
    let app = router(state.clone(), Some(Duration::from_millis(20)));

    // Refused operator receives 403 JSON, no SSE stream.
    let unknown_tok = signer.sign(UNKNOWN_EMAIL, AUD, ISSUER, 300, None)?;
    let resp = app
        .clone()
        .oneshot(
            Request::get("/api/ops/v1/events")
                .header("Cf-Access-Jwt-Assertion", unknown_tok)
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    assert_eq!(resp.headers()[header::CACHE_CONTROL], "no-store");

    // Open two live streams: full operator vs read.home-only operator.
    let full_tok = signer.sign(OPERATOR_EMAIL, AUD, ISSUER, 300, None)?;
    let home_only_tok = signer.sign(READ_HOME_ONLY_EMAIL, AUD, ISSUER, 300, None)?;

    let full_resp = app
        .clone()
        .oneshot(
            Request::get("/api/ops/v1/events")
                .header("Cf-Access-Jwt-Assertion", &full_tok)
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(full_resp.status(), StatusCode::OK);
    assert_eq!(full_resp.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(full_resp.headers()["x-accel-buffering"], "no");

    let limited_resp = app
        .clone()
        .oneshot(
            Request::get("/api/ops/v1/events")
                .header("Cf-Access-Jwt-Assertion", &home_only_tok)
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(limited_resp.status(), StatusCode::OK);

    // Mutate alerts so evaluation emits home.changed + alert.group.changed.
    tokio::time::sleep(Duration::from_millis(40)).await;
    {
        let now = OffsetDateTime::now_utc();
        sources
            .alerts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(Alert {
                fingerprint: "fp2".into(),
                labels: [
                    ("alertname".into(), "DiskFull".into()),
                    ("severity".into(), "page".into()),
                ]
                .into(),
                annotations: [("summary".into(), "Disk full".into())].into(),
                starts_at: now,
                ends_at: now + time::Duration::hours(1),
                status: AlertStatus {
                    state: AlertState::Active,
                    silenced_by: vec![],
                    inhibited_by: vec![],
                },
            });
    }
    state.apply_evaluation(&eval).await;

    let full_text = read_sse_until(full_resp.into_body(), "event: alert.group.changed").await?;
    assert!(full_text.contains("event: home.changed"), "{full_text}");
    assert!(
        full_text.contains("event: alert.group.changed"),
        "{full_text}"
    );

    let limited_text = read_sse_until(limited_resp.into_body(), "event: home.changed").await?;
    let _ = shutdown_tx.send(true);
    assert!(
        limited_text.contains("event: home.changed"),
        "{limited_text}"
    );
    assert!(
        !limited_text.contains("alert.group.changed"),
        "operator lacking read.alerts must not receive alert events: {limited_text}"
    );

    // Replay with Last-Event-ID: 1 replays event 2+, while out-of-range id emits resync.
    let (state2, eval2, sources2, shutdown_tx2) = make_state(&signer).await?;
    let app2 = router(state2.clone(), None);
    {
        let now = OffsetDateTime::now_utc();
        sources2
            .alerts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(Alert {
                fingerprint: "fp2".into(),
                labels: [
                    ("alertname".into(), "DiskFull".into()),
                    ("severity".into(), "page".into()),
                ]
                .into(),
                annotations: [("summary".into(), "Disk full".into())].into(),
                starts_at: now,
                ends_at: now + time::Duration::hours(1),
                status: AlertStatus {
                    state: AlertState::Active,
                    silenced_by: vec![],
                    inhibited_by: vec![],
                },
            });
    }
    state2.apply_evaluation(&eval2).await;

    let replay_resp = app2
        .clone()
        .oneshot(
            Request::get("/api/ops/v1/events")
                .header("Cf-Access-Jwt-Assertion", &full_tok)
                .header("Last-Event-ID", "1")
                .body(Body::empty())?,
        )
        .await?;
    let resync_resp = app2
        .oneshot(
            Request::get("/api/ops/v1/events")
                .header("Cf-Access-Jwt-Assertion", &full_tok)
                .header("Last-Event-ID", "99999")
                .body(Body::empty())?,
        )
        .await?;
    let replay_text = read_sse_until(replay_resp.into_body(), "event: alert.group.changed").await?;
    assert!(
        replay_text.contains("event: alert.group.changed"),
        "{replay_text}"
    );
    let resync_text = read_sse_until(resync_resp.into_body(), "event: resync").await?;
    let _ = shutdown_tx2.send(true);
    assert!(resync_text.contains("event: resync"), "{resync_text}");
    Ok(())
}
