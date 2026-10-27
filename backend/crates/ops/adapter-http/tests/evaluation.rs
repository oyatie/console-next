// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use std::{
    num::NonZeroU64,
    sync::atomic::{AtomicBool, Ordering},
};

use axum::http::StatusCode;
use console_ops_application::evaluation::AlertmanagerEvaluator;
use console_ops_application::{Alertmanager, AlertmanagerSnapshot, SourceFuture};
use console_ops_domain::ladders::{AlertState, Severity};
use console_ops_domain::{EvidenceState, Health, verdict};
use serde_json::json;
use time::macros::datetime;

mod support;
use support::Fixture;

struct PausingPort<'a> {
    port: &'a dyn Alertmanager,
    paused: AtomicBool,
}

impl Alertmanager for PausingPort<'_> {
    fn read(&self) -> SourceFuture<'_, AlertmanagerSnapshot> {
        if self.paused.load(Ordering::Relaxed) {
            Box::pin(std::future::pending())
        } else {
            self.port.read()
        }
    }
}

#[tokio::test]
async fn cancelling_a_read_never_restamps_the_previous_value_as_fresh() {
    let fixture = Fixture::new().await;
    let port = PausingPort {
        port: &fixture.source,
        paused: AtomicBool::new(false),
    };
    let mut evaluator =
        AlertmanagerEvaluator::new(&port, "fixture".into(), NonZeroU64::new(1).unwrap());
    let now = datetime!(2026-01-01 00:00 UTC);
    evaluator.tick(now).await;
    port.paused.store(true, Ordering::Relaxed);
    let at = now + time::Duration::SECOND;
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(1), evaluator.tick(at))
            .await
            .is_err()
    );
    let result = evaluator.evaluate(at);
    assert!(result.count.value().is_none());
    assert_eq!(result.count.reason(), Some("read incomplete"));
    assert!(result.groups[0].members_n.value().is_none());
}

#[tokio::test]
async fn the_next_due_read_invalidates_every_group_and_count_and_recovers() {
    let fixture = Fixture::new().await;
    let mut evaluator = AlertmanagerEvaluator::new(
        &fixture.source,
        "fixture".into(),
        NonZeroU64::new(1).unwrap(),
    );
    let now = datetime!(2026-01-01 00:00 UTC);
    assert_eq!(
        evaluator.evaluate(now).count.state(),
        EvidenceState::Unknown
    );
    assert!(evaluator.tick(now).await);
    let current = evaluator.evaluate(now);
    assert_eq!(current.count.value(), Some(&1));
    assert_eq!(current.groups[0].key, "SyntheticAlert×console-1");
    for field in [
        &current.groups[0].component,
        &current.groups[0].impact,
        &current.groups[0].first_action,
    ] {
        assert_eq!(field.reason(), Some("not instrumented"));
        assert!(field.value().is_none());
    }
    fixture.reply(
        "alerts",
        StatusCode::SERVICE_UNAVAILABLE,
        "source down".into(),
    );
    assert!(
        !evaluator
            .tick(now + time::Duration::milliseconds(999))
            .await
    );
    assert!(evaluator.tick(now + time::Duration::SECOND).await);
    let down = evaluator.evaluate(now + time::Duration::SECOND);
    assert_eq!(down.groups.len(), 1);
    assert!(down.count.value().is_none());
    assert_eq!(down.count.reason(), Some("source down"));
    assert_eq!(down.alert_count.reason(), Some("source down"));
    assert!(down.alert_count.value().is_none());
    assert_eq!(down.groups[0].members_n.reason(), Some("source down"));
    assert!(down.groups[0].summary.value().is_none());
    assert_eq!(down.groups[0].component.reason(), Some("source down"));
    let home = verdict(
        Health::Healthy,
        &[],
        &[(down.source.state(), down.source.reason())],
    );
    assert_eq!(home.worst, Health::Unknown);
    assert!(home.text.contains("Unknown: source down"));
    fixture.set("alerts", json!([]));
    assert!(evaluator.tick(now + time::Duration::seconds(2)).await);
    let recovered = evaluator.evaluate(now + time::Duration::seconds(2));
    assert_eq!(recovered.count.value(), Some(&0));
    assert!(recovered.groups.is_empty());
}

#[tokio::test]
async fn stalled_evaluation_marks_source_groups_and_count_stale_at_one_shared_boundary() {
    let fixture = Fixture::new().await;
    let mut evaluator = AlertmanagerEvaluator::new(
        &fixture.source,
        "fixture".into(),
        NonZeroU64::new(60).unwrap(),
    );
    let now = datetime!(2026-01-01 00:00 UTC);
    evaluator.tick(now).await;
    assert_eq!(
        evaluator
            .evaluate(now + time::Duration::seconds(120))
            .count
            .value(),
        Some(&1)
    );
    let stale = evaluator.evaluate(now + time::Duration::seconds(180));
    assert_eq!(stale.count.reason(), Some("stale 3m"));
    assert_eq!(stale.alert_count.reason(), Some("stale 3m"));
    assert!(stale.alert_count.value().is_none());
    assert!(stale.count.value().is_none());
    assert_eq!(stale.source.reason(), Some("stale 3m"));
    assert_eq!(stale.groups[0].members_n.reason(), Some("stale 3m"));
    assert!(stale.groups[0].state.value().is_none());
}

#[tokio::test]
async fn groups_use_component_then_job_and_do_not_guess_unknown_severity() {
    let fixture = Fixture::new().await;
    let mut alert: serde_json::Value =
        serde_json::from_str(&fixture.replies.lock().unwrap()["/monitoring/api/v2/alerts"].2)
            .unwrap();
    alert[0]["labels"]["component"] = json!("console-1");
    alert[0]["labels"]["job"] = json!("different-job");
    alert[0]["annotations"]["impact"] = json!("Synthetic impact");
    let mut second = alert[0].clone();
    second["fingerprint"] = json!("second-fingerprint");
    second["labels"]["job"] = json!("other-job");
    alert.as_array_mut().unwrap().push(second);
    fixture.set("alerts", alert);
    let mut evaluator = AlertmanagerEvaluator::new(
        &fixture.source,
        "fixture".into(),
        NonZeroU64::new(1).unwrap(),
    );
    let now = datetime!(2026-01-01 00:00 UTC);
    evaluator.tick(now).await;
    let result = evaluator.evaluate(now);
    assert_eq!(result.groups.len(), 1);
    assert_eq!(result.groups[0].members_n.value(), Some(&2));
    assert_eq!(result.count.value(), Some(&1));
    assert_eq!(result.alert_count.value(), Some(&2));
    assert_eq!(result.groups[0].severity.reason(), Some("not instrumented"));
    assert_eq!(
        result.groups[0].impact.value().map(String::as_str),
        Some("Synthetic impact")
    );
}

#[tokio::test]
async fn empty_labels_and_annotations_are_unknown_not_verified_strings() {
    let fixture = Fixture::new().await;
    let mut alerts: serde_json::Value =
        serde_json::from_str(&fixture.replies.lock().unwrap()["/monitoring/api/v2/alerts"].2)
            .unwrap();
    alerts[0]["labels"]["component"] = json!("");
    alerts[0]["annotations"]["summary"] = json!("");
    fixture.set("alerts", alerts);
    let mut evaluator = AlertmanagerEvaluator::new(
        &fixture.source,
        "fixture".into(),
        NonZeroU64::new(1).unwrap(),
    );
    let now = datetime!(2026-01-01 00:00 UTC);
    evaluator.tick(now).await;
    let result = evaluator.evaluate(now);
    for field in [&result.groups[0].component, &result.groups[0].summary] {
        assert_eq!(field.state(), EvidenceState::Unknown);
        assert!(field.value().is_none());
        assert_eq!(field.reason(), Some("not instrumented"));
    }
}

#[tokio::test]
async fn members_disagreeing_on_severity_are_unknown_with_a_distinct_reason() {
    let fixture = Fixture::new().await;
    let mut alerts: serde_json::Value =
        serde_json::from_str(&fixture.replies.lock().unwrap()["/monitoring/api/v2/alerts"].2)
            .unwrap();
    alerts[0]["labels"]["severity"] = json!("page");
    let mut second = alerts[0].clone();
    second["fingerprint"] = json!("second-fingerprint");
    second["labels"]["severity"] = json!("ticket");
    alerts.as_array_mut().unwrap().push(second);
    fixture.set("alerts", alerts);
    let mut evaluator = AlertmanagerEvaluator::new(
        &fixture.source,
        "fixture".into(),
        NonZeroU64::new(1).unwrap(),
    );
    let now = datetime!(2026-01-01 00:00 UTC);
    evaluator.tick(now).await;
    let result = evaluator.evaluate(now);
    assert_eq!(result.groups.len(), 1);
    assert_eq!(result.groups[0].members_n.value(), Some(&2));
    assert_eq!(result.groups[0].severity.state(), EvidenceState::Unknown);
    assert!(result.groups[0].severity.value().is_none());
    assert_eq!(result.groups[0].severity.reason(), Some("members disagree"));
}

#[tokio::test]
async fn suppression_and_unprocessed_states_are_preserved_and_invalid_reads_drop_current_values() {
    let fixture = Fixture::new().await;
    let original: serde_json::Value =
        serde_json::from_str(&fixture.replies.lock().unwrap()["/monitoring/api/v2/alerts"].2)
            .unwrap();
    let mut evaluator = AlertmanagerEvaluator::new(
        &fixture.source,
        "fixture".into(),
        NonZeroU64::new(1).unwrap(),
    );
    let now = datetime!(2026-01-01 00:00 UTC);
    for (index, (status, expected, severity)) in [
        (
            json!({"state":"active","silencedBy":[],"inhibitedBy":[]}),
            Some(AlertState::Firing),
            "page",
        ),
        (
            json!({"state":"suppressed","silencedBy":["fixture"],"inhibitedBy":[]}),
            Some(AlertState::Silenced),
            "ticket",
        ),
        (
            json!({"state":"suppressed","silencedBy":[],"inhibitedBy":["fixture"]}),
            Some(AlertState::Inhibited),
            "page",
        ),
        (
            json!({"state":"unprocessed","silencedBy":[],"inhibitedBy":[]}),
            None,
            "ticket",
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let mut alerts = original.clone();
        alerts[0]["status"] = status;
        alerts[0]["labels"]["severity"] = json!(severity);
        fixture.set("alerts", alerts);
        let at = now + time::Duration::seconds(index as i64);
        evaluator.tick(at).await;
        let result = evaluator.evaluate(at);
        assert_eq!(result.groups[0].state.value().copied(), expected);
        assert_eq!(
            result.groups[0].severity.value(),
            Some(&if severity == "page" {
                Severity::Page
            } else {
                Severity::Ticket
            })
        );
    }
    fixture.set("alerts", json!([{}]));
    let at = now + time::Duration::seconds(4);
    evaluator.tick(at).await;
    let invalid = evaluator.evaluate(at);
    assert_eq!(invalid.count.reason(), Some("invalid source response"));
    assert!(invalid.groups[0].severity.value().is_none());
}
