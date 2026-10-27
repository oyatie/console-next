// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use axum::http::{StatusCode, header};
use console_ops_adapter_http::HttpAlertmanager;
use console_ops_application::{Alertmanager, SourceError};
use serde_json::{Value, json};
use std::num::NonZeroU64;
mod support;
use support::{Fixture, limits};

#[tokio::test]
async fn reads_all_three_endpoints_preserving_uninstrumented_fields_and_matcher_defaults() {
    let fixture = Fixture::new().await;
    let port: &dyn Alertmanager = &fixture.source;
    let snapshot = port.read().await.unwrap();
    assert_eq!(snapshot.alerts[0].labels["alertname"], "SyntheticAlert");
    assert!(!snapshot.alerts[0].labels.contains_key("component"));
    assert!(!snapshot.alerts[0].annotations.contains_key("impact"));
    assert!(!snapshot.alerts[0].annotations.contains_key("first_action"));
    assert!(snapshot.silences[0].matchers[0].is_equal);
    assert_eq!(snapshot.status.version_info.version, "fixture");
}

#[tokio::test]
async fn a_failure_in_any_endpoint_drops_the_entire_current_read_and_can_recover() {
    for path in ["alerts", "silences", "status"] {
        let fixture = Fixture::new().await;
        assert!(fixture.source.read().await.is_ok());
        let original =
            fixture.replies.lock().unwrap()[&format!("/monitoring/api/v2/{path}")].clone();
        fixture.reply(path, StatusCode::SERVICE_UNAVAILABLE, "source down".into());
        assert_eq!(fixture.source.read().await.unwrap_err(), SourceError::Down);
        fixture.reply(path, original.0, original.2);
        assert!(fixture.source.read().await.is_ok());
    }
}

#[tokio::test]
async fn empty_lists_are_valid_but_missing_or_malformed_evidence_is_not() {
    let fixture = Fixture::new().await;
    fixture.set("alerts", json!([]));
    fixture.set("silences", json!([]));
    let empty = fixture.source.read().await.unwrap();
    assert!(empty.alerts.is_empty() && empty.silences.is_empty());
    for body in [json!({}), json!(null), json!([{}]), json!([{"labels": {}}])] {
        fixture.set("alerts", body);
        assert_eq!(
            fixture.source.read().await.unwrap_err(),
            SourceError::Invalid
        );
    }
    fixture.reply("alerts", StatusCode::OK, "{".into());
    assert_eq!(
        fixture.source.read().await.unwrap_err(),
        SourceError::Invalid
    );
}

#[tokio::test]
async fn wrong_timestamps_unknown_states_and_missing_required_fields_fail_closed() {
    let fixture = Fixture::new().await;
    let original: Value =
        serde_json::from_str(&fixture.replies.lock().unwrap()["/monitoring/api/v2/alerts"].2)
            .unwrap();
    for field in [
        "fingerprint",
        "labels",
        "annotations",
        "startsAt",
        "endsAt",
        "status",
    ] {
        let mut body = original.clone();
        body[0].as_object_mut().unwrap().remove(field);
        fixture.set("alerts", body);
        assert_eq!(
            fixture.source.read().await.unwrap_err(),
            SourceError::Invalid,
            "{field}"
        );
    }
    for (pointer, value) in [
        ("/0/startsAt", json!("tomorrow")),
        ("/0/status/state", json!("healthy")),
        ("/0/labels/alertname", json!("")),
        ("/0/fingerprint", json!("")),
    ] {
        let mut body = original.clone();
        *body.pointer_mut(pointer).unwrap() = value;
        fixture.set("alerts", body);
        assert_eq!(
            fixture.source.read().await.unwrap_err(),
            SourceError::Invalid,
            "{pointer}"
        );
    }
    let mut body = original;
    body[0]["labels"]
        .as_object_mut()
        .unwrap()
        .remove("alertname");
    fixture.set("alerts", body);
    assert_eq!(
        fixture.source.read().await.unwrap_err(),
        SourceError::Invalid
    );
}

#[tokio::test]
async fn redirects_are_not_followed_and_disconnections_are_source_down() {
    let fixture = Fixture::new().await;
    fixture.reply("alerts", StatusCode::FOUND, "[]".into());
    fixture.set("redirect-target", json!([]));
    fixture
        .replies
        .lock()
        .unwrap()
        .get_mut("/monitoring/api/v2/alerts")
        .unwrap()
        .1
        .insert(
            header::LOCATION,
            "/monitoring/api/v2/redirect-target".parse().unwrap(),
        );
    assert_eq!(fixture.source.read().await.unwrap_err(), SourceError::Down);
    fixture.task.abort();
    assert_eq!(fixture.source.read().await.unwrap_err(), SourceError::Down);
}

#[tokio::test]
async fn an_unresponsive_source_times_out_within_its_declared_interval() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let source = HttpAlertmanager::new(
        &format!("http://{}", listener.local_addr().unwrap()),
        NonZeroU64::new(1).unwrap(),
        limits(),
    )
    .unwrap();
    // Keep the socket open without responding: the request deadline must cover the body too.
    assert_eq!(
        tokio::time::timeout(std::time::Duration::from_secs(3), source.read())
            .await
            .unwrap()
            .unwrap_err(),
        SourceError::Down
    );
}

#[test]
fn invalid_source_urls_are_refused_at_construction() {
    for url in [
        "not a URL",
        "file:///tmp/fixture",
        "ftp://example.invalid",
        "https://example.invalid/?query=x",
        "https://example.invalid/#fragment",
        "http://user:password@example.invalid",
        "http://user@example.invalid",
    ] {
        assert!(matches!(
            HttpAlertmanager::new(url, NonZeroU64::new(1).unwrap(), limits()),
            Err(SourceError::Configuration)
        ));
    }
}
