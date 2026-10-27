// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use std::{collections::BTreeSet, num::NonZeroU64};

use console_ops_application::evaluation::AlertmanagerEvaluator;
use serde_json::json;
use time::macros::datetime;

mod support;
use support::Fixture;

#[tokio::test]
async fn group_keys_escape_both_parts_without_colliding_with_literal_escape_sequences() {
    let fixture = Fixture::new().await;
    let original: serde_json::Value =
        serde_json::from_str(&fixture.replies.lock().unwrap()["/monitoring/api/v2/alerts"].2)
            .unwrap();
    let alerts: Vec<_> = [
        ("A×B", "C"),
        ("A", "B×C"),
        ("A%C3%97B", "C"),
        ("A", "B%C3%97C"),
    ]
    .into_iter()
    .enumerate()
    .map(|(index, (alertname, job))| {
        let mut alert = original[0].clone();
        alert["fingerprint"] = json!(format!("fixture-{index}"));
        alert["labels"]["alertname"] = json!(alertname);
        alert["labels"]["job"] = json!(job);
        alert
    })
    .collect();
    fixture.set("alerts", json!(alerts));
    let mut evaluator = AlertmanagerEvaluator::new(
        &fixture.source,
        "fixture".into(),
        NonZeroU64::new(1).unwrap(),
    );
    let now = datetime!(2026-01-01 00:00 UTC);
    evaluator.tick(now).await;
    let result = evaluator.evaluate(now);
    assert_eq!(result.groups.len(), 4);
    assert_eq!(
        result
            .groups
            .iter()
            .map(|group| group.key.as_str())
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([
            "A%C3%97B×C",
            "A×B%C3%97C",
            "A%25C3%2597B×C",
            "A×B%25C3%2597C"
        ])
    );
}
