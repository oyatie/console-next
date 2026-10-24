// SPDX-License-Identifier: LicenseRef-Proprietary
use super::test_support::{Log, serve};
use super::tests::{SECRET, config, down};
use super::*;
use console_platform_key_notice::KeyState;
use std::time::Duration;
use tracing::instrument::WithSubscriber;
use tracing_subscriber::fmt::format::FmtSpan;
#[tokio::test]
async fn local_budget_gateway_quota_rejected_key_and_timeout_have_allowed_counterparts() {
    let (url, seen) = serve(None).await;
    let mut c = config(url);
    c.rate_per_minute = 1;
    let client = NtsClient::new(c);
    let number = ["0008100009".into()];
    assert!(client.status(&number).await.is_ok());
    assert!(matches!(
        client.status(&number).await,
        Err(CheckFailure::RateLimited {
            retry_after_seconds: 1..=60,
            gateway_code: None
        })
    ));
    assert_eq!(seen.lock().unwrap().len(), 1);
    for (body, expected) in [
        (
            r#"{"code":22}"#,
            CheckFailure::RateLimited {
                retry_after_seconds: 60,
                gateway_code: Some("22".into()),
            },
        ),
        (
            r#"{"code":23}"#,
            CheckFailure::RateLimited {
                retry_after_seconds: 60,
                gateway_code: Some("23".into()),
            },
        ),
        ("timeout", down()),
    ] {
        let (url, _) = serve(Some((200, body))).await;
        let mut c = config(url);
        if body == "timeout" {
            c.timeout = Duration::from_millis(30);
        }
        assert_eq!(NtsClient::new(c).status(&number).await, Err(expected));
    }
    let (url, seen) = serve(Some((401, r#"{"code":-4}"#))).await;
    let client = NtsClient::new(config(url));
    for _ in 0..2 {
        assert_eq!(
            client.status(&number).await,
            Err(CheckFailure::Unavailable(UnavailableReason::KeyRejected))
        );
    }
    assert_eq!(seen.lock().unwrap().len(), 1);
    assert_eq!(client.key_notices()[0].state, KeyState::Rejected);
}

#[tokio::test]
async fn captured_spans_errors_and_debug_never_contain_the_service_key() {
    let (url, _) = serve(Some((
        401,
        r#"{"code":-4,"msg":"fixture-key-never-log-8e2a"}"#,
    )))
    .await;
    let client = NtsClient::new(config(url));
    let log = Log::default();
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .with_span_events(FmtSpan::FULL)
        .with_ansi(false)
        .with_writer(log.clone())
        .finish();
    let result = client
        .status(&["0008100009".into()])
        .with_subscriber(subscriber)
        .await;
    let output = String::from_utf8(log.0.lock().unwrap().clone()).unwrap();
    assert!(
        output.contains("registration_check"),
        "capture must include the adapter span"
    );
    for text in [output, format!("{result:?}"), format!("{client:?}")] {
        assert!(
            !text.contains(SECRET),
            "service key leaked into diagnostic output"
        );
    }
}

#[tokio::test]
async fn gateway_expiry_and_rejection_are_visible_to_vendor_ops_without_leaking_the_key() {
    for (body, reason, state) in [
        (
            r#"{"code":31}"#,
            UnavailableReason::KeyExpired,
            KeyState::Expired,
        ),
        (
            r#"{"code":-4}"#,
            UnavailableReason::KeyRejected,
            KeyState::Rejected,
        ),
    ] {
        let (url, _) = serve(Some((401, body))).await;
        let client = NtsClient::new(config(url));
        assert_eq!(
            client.status(&["0008100009".into()]).await,
            Err(CheckFailure::Unavailable(reason))
        );
        let notice = client.key_notices().remove(0);
        assert_eq!(notice.state, state);
        assert_eq!(notice.env, "NTS_BUSINESSMAN_API_KEY");
        assert!(!serde_json::to_string(&notice).unwrap().contains(SECRET));
    }
}
