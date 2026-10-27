// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use std::num::NonZeroU64;

use console_ops_application::evaluation::AlertmanagerEvaluator;
use console_ops_domain::EvidenceState;
use serde_json::json;
use time::macros::datetime;

mod support;
use support::Fixture;

#[tokio::test]
async fn off_ladder_severity_is_unknown_and_names_the_instrumented_value() {
    let fixture = Fixture::new().await;
    let mut alerts: serde_json::Value =
        serde_json::from_str(&fixture.replies.lock().unwrap()["/monitoring/api/v2/alerts"].2)
            .unwrap();
    alerts[0]["labels"]["severity"] = json!("critical");
    fixture.set("alerts", alerts);
    let mut evaluator = AlertmanagerEvaluator::new(
        &fixture.source,
        "fixture".into(),
        NonZeroU64::new(1).unwrap(),
    );
    let now = datetime!(2026-01-01 00:00 UTC);
    evaluator.tick(now).await;
    let result = evaluator.evaluate(now);
    assert_eq!(result.groups[0].severity.state(), EvidenceState::Unknown);
    assert!(result.groups[0].severity.value().is_none());
    assert_eq!(
        result.groups[0].severity.reason(),
        Some("severity critical not on the ladder")
    );
}

#[tokio::test]
async fn one_missing_member_field_disagrees_with_a_present_value() {
    let fixture = Fixture::new().await;
    let mut alerts: serde_json::Value =
        serde_json::from_str(&fixture.replies.lock().unwrap()["/monitoring/api/v2/alerts"].2)
            .unwrap();
    let mut second = alerts[0].clone();
    second["fingerprint"] = json!("second-fingerprint");
    second["labels"]["severity"] = json!("page");
    second["annotations"]["impact"] = json!("Synthetic impact");
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
    assert_eq!(result.groups[0].severity.reason(), Some("members disagree"));
    assert!(result.groups[0].severity.value().is_none());
    assert_eq!(result.groups[0].impact.reason(), Some("members disagree"));
    assert!(result.groups[0].impact.value().is_none());
}
