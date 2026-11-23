// SPDX-License-Identifier: LicenseRef-Proprietary
use std::fs;

use axum::http::StatusCode;
use serde_json::json;
use time::macros::datetime;

mod oc1_support;
use oc1_support::{build_harness, req_get, req_post, send_json};

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[tokio::test]
async fn home_surfaces_unknown_evidence_when_incidents_or_actions_spool_is_broken() -> TestResult {
    let h = build_harness(Some(datetime!(2026-11-23 00:00:00 UTC))).await?;
    let (st, _, _) = send_json(
        &h.app,
        req_post(
            "/api/ops/v1/incidents",
            &h.operator_jwt,
            json!({
                "title": "Spool test",
                "sev": "SEV3",
                "affected_components": ["api"],
                "personal_data_impact": "no",
                "discovered_at": "2026-11-23T00:00:00Z"
            }),
        ),
    )
    .await?;
    assert_eq!(st, StatusCode::CREATED);
    let (st, _, _) = send_json(
        &h.app,
        req_post("/api/ops/v1/oncall/page-test", &h.operator_jwt, json!({})),
    )
    .await?;
    assert_eq!(st, StatusCode::CREATED);

    // Corrupt actions spool first; home_only must NOT see actions error (Cedar read.running),
    // while full operator sees Unknown evidence and worst == Unknown.
    fs::write(h.dirs.records.join("actions/00000001.json"), "{broken")?;
    let (st, _, home_limited) =
        send_json(&h.app, req_get("/api/ops/v1/home", &h.home_only_jwt)).await?;
    assert_eq!(st, StatusCode::OK, "{home_limited}");
    assert_ne!(home_limited["verdict"]["worst"], "Unknown");
    assert_eq!(home_limited["evidence"]["counts"]["Unknown"], 0);

    let (st, _, home_full) =
        send_json(&h.app, req_get("/api/ops/v1/home", &h.operator_jwt)).await?;
    assert_eq!(st, StatusCode::OK, "{home_full}");
    assert_eq!(home_full["verdict"]["worst"], "Unknown");
    assert_eq!(home_full["evidence"]["counts"]["Unknown"], 1);
    assert!(
        home_full["evidence"]["sources"]
            .as_array()
            .is_some_and(|s| s
                .iter()
                .any(|src| src["name"] == "actions" && src["state"] == "Unknown"))
    );

    // Corrupt incidents spool too; both home_only and full operator see Unknown evidence.
    fs::write(h.dirs.records.join("incidents/00000001.json"), "{broken")?;
    let (st, _, home_inc) =
        send_json(&h.app, req_get("/api/ops/v1/home", &h.home_only_jwt)).await?;
    assert_eq!(st, StatusCode::OK, "{home_inc}");
    assert_eq!(home_inc["verdict"]["worst"], "Unknown");
    assert_eq!(home_inc["evidence"]["counts"]["Unknown"], 1);
    assert!(home_inc["evidence"]["sources"].as_array().is_some_and(|s| {
        s.iter()
            .any(|src| src["name"] == "incidents" && src["state"] == "Unknown")
    }));
    Ok(())
}
