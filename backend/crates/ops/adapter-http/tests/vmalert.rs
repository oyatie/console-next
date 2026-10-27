// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use std::num::NonZeroU64;

use axum::http::{HeaderMap, StatusCode};
use console_ops_adapter_http::{HttpReadLimits, HttpVmalert};
use console_ops_application::{SourceError, Vmalert};
use serde_json::{Value, json};

mod support;
use support::{Fixture, limits};

fn reply(fixture: &Fixture, path: &str, status: StatusCode, body: Value) {
    fixture.replies.lock().unwrap().insert(
        format!("/monitoring/api/v1/{path}"),
        (status, HeaderMap::new(), body.to_string()),
    );
}

fn rules() -> Value {
    json!({"status":"success","data":{"groups":[{
        "id":"3", "name":"fixture", "file":"fixture.yml", "rules":[
            {"id":"2", "name":"SyntheticAlert", "query":"up == 0", "type":"alerting", "state":"firing", "lastEvaluation":"2026-01-01T00:00:00Z", "health":"ok", "lastError":"", "labels":{"severity":"page"}},
            {"id":"4", "name":"synthetic:up", "query":"sum(up)", "type":"recording", "state":"", "lastEvaluation":"2026-01-01T00:00:00Z", "health":"ok", "lastError":""}
        ]
    }]}})
}

fn alerts() -> Value {
    json!({"status":"success","data":{"alerts":[{
        "labels":{"alertname":"SyntheticAlert","job":"console-1"},
        "annotations":{"summary":"Synthetic fixture"}, "state":"firing",
        "activeAt":"2026-01-01T00:00:00Z", "value":"0", "id":"1", "rule_id":"2", "group_id":"3",
        "expression":"up == 0", "source":"https://example.invalid/alert"
    }]}})
}

fn source(fixture: &Fixture) -> HttpVmalert {
    HttpVmalert::new(&fixture.url, NonZeroU64::new(1).unwrap(), limits()).unwrap()
}

fn healthy(fixture: &Fixture) {
    reply(fixture, "rules", StatusCode::OK, rules());
    reply(fixture, "alerts", StatusCode::OK, alerts());
}

#[tokio::test]
async fn reads_rules_and_active_alerts_through_the_port_and_preserves_rule_errors() {
    let fixture = Fixture::new().await;
    healthy(&fixture);
    let snapshot = source(&fixture).read().await.unwrap();
    assert_eq!(snapshot.groups[0].name, "fixture");
    assert_eq!(snapshot.groups[0].id, snapshot.alerts[0].group_id);
    assert_eq!(snapshot.groups[0].rules[0].id, snapshot.alerts[0].rule_id);
    assert_eq!(snapshot.groups[0].rules[0].query, "up == 0");
    assert_eq!(snapshot.alerts[0].labels["job"], "console-1");
    assert_eq!(snapshot.alerts[0].value, "0");
    assert_eq!(snapshot.alerts[0].active_at.unix_timestamp(), 1767225600);
    let mut failed_rule = rules();
    failed_rule["data"]["groups"][0]["rules"][0]["health"] = json!("err");
    failed_rule["data"]["groups"][0]["rules"][0]["lastError"] = json!("synthetic query failed");
    reply(&fixture, "rules", StatusCode::OK, failed_rule);
    assert_eq!(
        source(&fixture).read().await.unwrap().groups[0].rules[0].last_error,
        "synthetic query failed"
    );
}

#[tokio::test]
async fn either_endpoint_failing_discards_the_read_and_the_next_read_recovers() {
    let fixture = Fixture::new().await;
    for path in ["rules", "alerts"] {
        healthy(&fixture);
        let port = source(&fixture);
        assert!(port.read().await.is_ok());
        reply(&fixture, path, StatusCode::SERVICE_UNAVAILABLE, json!({}));
        assert_eq!(port.read().await.unwrap_err(), SourceError::Down);
        healthy(&fixture);
        assert!(port.read().await.is_ok());
    }
}

#[tokio::test]
async fn success_empty_is_distinct_from_error_missing_null_and_malformed_data() {
    let fixture = Fixture::new().await;
    healthy(&fixture);
    for (path, key) in [("rules", "groups"), ("alerts", "alerts")] {
        for body in [
            json!({}),
            json!(null),
            json!({"status":"error","data":{key:[]}}),
            json!({"status":"success","data":{}}),
            json!({"status":"success","data":{key:null}}),
        ] {
            reply(&fixture, path, StatusCode::OK, body);
            assert_eq!(
                source(&fixture).read().await.unwrap_err(),
                SourceError::Invalid,
                "{path}"
            );
        }
        reply(
            &fixture,
            path,
            StatusCode::OK,
            json!({"status":"success","data":{key:[]}}),
        );
    }
    let snapshot = source(&fixture).read().await.unwrap();
    assert!(snapshot.groups.is_empty() && snapshot.alerts.is_empty());
}

#[tokio::test]
async fn invalid_rule_types_states_identities_and_alert_timestamps_are_refused() {
    let fixture = Fixture::new().await;
    for (path, original, pointer, value) in [
        ("rules", rules(), "/data/groups/0/id", json!("")),
        ("rules", rules(), "/data/groups/0/name", json!("")),
        ("rules", rules(), "/data/groups/0/rules/0/id", json!("")),
        ("rules", rules(), "/data/groups/0/rules/0/name", json!("")),
        ("rules", rules(), "/data/groups/0/rules/0/query", json!("")),
        (
            "rules",
            rules(),
            "/data/groups/0/rules/0/type",
            json!("guessed"),
        ),
        (
            "rules",
            rules(),
            "/data/groups/0/rules/0/state",
            json!("quiet"),
        ),
        (
            "rules",
            rules(),
            "/data/groups/0/rules/0/health",
            json!("healthy"),
        ),
        (
            "alerts",
            alerts(),
            "/data/alerts/0/state",
            json!("inactive"),
        ),
        (
            "alerts",
            alerts(),
            "/data/alerts/0/labels/alertname",
            json!(""),
        ),
        ("alerts", alerts(), "/data/alerts/0/rule_id", json!("")),
        ("alerts", alerts(), "/data/alerts/0/group_id", json!("")),
        ("alerts", alerts(), "/data/alerts/0/expression", json!("")),
        (
            "alerts",
            alerts(),
            "/data/alerts/0/activeAt",
            json!("tomorrow"),
        ),
        ("alerts", alerts(), "/data/alerts/0/value", json!(0)),
    ] {
        healthy(&fixture);
        let mut body = original;
        *body.pointer_mut(pointer).unwrap() = value;
        reply(&fixture, path, StatusCode::OK, body);
        assert_eq!(
            source(&fixture).read().await.unwrap_err(),
            SourceError::Invalid,
            "{pointer}"
        );
    }
}

#[tokio::test]
async fn vmalert_reuses_the_response_cap_timeout_and_redirect_refusal() {
    let fixture = Fixture::new().await;
    healthy(&fixture);
    let tiny: HttpReadLimits =
        serde_json::from_value(json!({"request_timeout_ms":500,"max_response_bytes":1})).unwrap();
    let port = HttpVmalert::new(&fixture.url, NonZeroU64::new(1).unwrap(), tiny).unwrap();
    assert_eq!(port.read().await.unwrap_err(), SourceError::Invalid);
    reply(&fixture, "rules", StatusCode::FOUND, rules());
    assert_eq!(
        source(&fixture).read().await.unwrap_err(),
        SourceError::Down
    );
    let invalid: HttpReadLimits =
        serde_json::from_value(json!({"request_timeout_ms":1000,"max_response_bytes":4096}))
            .unwrap();
    assert!(matches!(
        HttpVmalert::new(&fixture.url, NonZeroU64::new(1).unwrap(), invalid),
        Err(SourceError::Configuration)
    ));
    fixture.task.abort();
    assert_eq!(
        source(&fixture).read().await.unwrap_err(),
        SourceError::Down
    );
}
