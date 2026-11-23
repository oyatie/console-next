// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use std::{collections::BTreeSet, num::NonZeroU64};

use console_ops_application::alerts_eval::compute_group_key;
use console_ops_application::evaluation::AlertmanagerEvaluator;
use serde_json::json;
use time::macros::datetime;

mod support;
use support::Fixture;

#[tokio::test]
async fn group_keys_use_8_hex_sha256_of_alertname_and_component_with_alertgroup_fallback() {
    let fixture = Fixture::new().await;
    let original: serde_json::Value =
        serde_json::from_str(&fixture.replies.lock().unwrap()["/monitoring/api/v2/alerts"].2)
            .unwrap();
    let alerts: Vec<_> = [
        ("A×B", Some("C"), None),
        ("A", Some("B×C"), None),
        ("A%C3%97B", None, Some("C")),
        ("A", None, Some("B%C3%97C")),
    ]
    .into_iter()
    .enumerate()
    .map(|(index, (alertname, component, alertgroup))| {
        let mut alert = original[0].clone();
        alert["fingerprint"] = json!(format!("fixture-{index}"));
        alert["labels"]["alertname"] = json!(alertname);
        alert["labels"].as_object_mut().unwrap().remove("component");
        alert["labels"]
            .as_object_mut()
            .unwrap()
            .remove("alertgroup");
        if let Some(comp) = component {
            alert["labels"]["component"] = json!(comp);
        }
        if let Some(ag) = alertgroup {
            alert["labels"]["alertgroup"] = json!(ag);
        }
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
            compute_group_key("A×B", "C").as_str(),
            compute_group_key("A", "B×C").as_str(),
            compute_group_key("A%C3%97B", "C").as_str(),
            compute_group_key("A", "B%C3%97C").as_str(),
        ])
    );
    for group in &result.groups {
        assert_eq!(group.key.len(), 8);
        assert!(
            group
                .key
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        );
    }
}
