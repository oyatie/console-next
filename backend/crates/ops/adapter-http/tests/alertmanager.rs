// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use std::{
    collections::BTreeMap,
    num::NonZeroU64,
    sync::{Arc, Mutex},
};

use axum::{
    Router,
    extract::{OriginalUri, State},
    http::StatusCode,
    response::IntoResponse,
};
use console_ops_adapter_http::HttpAlertmanager;
use console_ops_application::{Alertmanager, SourceError};
use serde_json::{Value, json};

type Replies = Arc<Mutex<BTreeMap<String, (StatusCode, String)>>>;

struct Fixture {
    replies: Replies,
    task: tokio::task::JoinHandle<()>,
    source: HttpAlertmanager,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Fixture {
    async fn new() -> Self {
        let replies = Arc::new(Mutex::new(BTreeMap::new()));
        let app = Router::new()
            .fallback(
                |State(replies): State<Replies>, uri: OriginalUri| async move {
                    let reply = replies.lock().unwrap().get(uri.path()).cloned();
                    reply
                        .unwrap_or((StatusCode::NOT_FOUND, "not a fixture route".into()))
                        .into_response()
                },
            )
            .with_state(Arc::clone(&replies));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/monitoring/", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let fixture = Self {
            replies,
            task,
            source: HttpAlertmanager::new(&url, NonZeroU64::new(1).unwrap()).unwrap(),
        };
        fixture.set("alerts", json!([{
            "fingerprint": "fixture-fingerprint", "labels": {"alertname": "SyntheticAlert", "job": "console-1"},
            "annotations": {"summary": "Synthetic fixture alert"},
            "startsAt": "2026-01-01T00:00:00Z", "endsAt": "2026-01-01T01:00:00Z",
            "status": {"state": "active", "silencedBy": [], "inhibitedBy": []}
        }]));
        fixture.set("silences", json!([{
            "id": "fixture-silence", "matchers": [{"name": "job", "value": "console-1", "isRegex": false}],
            "startsAt": "2026-01-01T00:00:00Z", "endsAt": "2026-01-02T00:00:00Z", "createdBy": "fixture", "comment": "Synthetic silence"
        }]));
        fixture.set("status", json!({"versionInfo": {"version": "fixture"}, "uptime": "2026-01-01T00:00:00Z", "config": {"original": "must not enter the snapshot"}}));
        fixture
    }

    fn set(&self, path: &str, body: Value) {
        self.reply(path, StatusCode::OK, body.to_string());
    }
    fn reply(&self, path: &str, status: StatusCode, body: String) {
        self.replies
            .lock()
            .unwrap()
            .insert(format!("/monitoring/api/v2/{path}"), (status, body));
    }
}

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
        fixture.reply(path, original.0, original.1);
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
        serde_json::from_str(&fixture.replies.lock().unwrap()["/monitoring/api/v2/alerts"].1)
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
}

#[tokio::test]
async fn redirects_are_not_followed_and_disconnections_are_source_down() {
    let fixture = Fixture::new().await;
    fixture.reply("alerts", StatusCode::FOUND, "[]".into());
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
        "https://example.invalid/?query=x",
        "https://example.invalid/#fragment",
        "http://user:password@example.invalid",
    ] {
        assert!(matches!(
            HttpAlertmanager::new(url, NonZeroU64::new(1).unwrap()),
            Err(SourceError::Configuration)
        ));
    }
}
