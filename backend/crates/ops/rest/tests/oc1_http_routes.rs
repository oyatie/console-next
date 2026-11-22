// SPDX-License-Identifier: LicenseRef-Proprietary
use std::fs;
use std::os::unix::fs::symlink;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use serde_json::json;
use time::macros::datetime;

mod oc1_support;
use oc1_support::{assert_no_store_no_cors, build_harness, req_get, req_post, send_json};

type TestResult = Result<(), Box<dyn std::error::Error>>;

const DIGEST: &str = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

#[tokio::test]
async fn oncall_jobs_health_changes_promote_recovery_actions_and_runbooks() -> TestResult {
    let h = build_harness(Some(datetime!(2026-11-23 00:00:00 UTC))).await?;

    // Oncall + page-test
    let (st, hdrs, oc) = send_json(&h.app, req_get("/api/ops/v1/oncall", &h.operator_jwt)).await?;
    assert_eq!(st, StatusCode::OK, "{oc}");
    assert_no_store_no_cors(&hdrs);
    assert_eq!(oc["config"]["mode"], "single-operator");
    let (st, _, pt) = send_json(
        &h.app,
        req_post("/api/ops/v1/oncall/page-test", &h.operator_jwt, json!({})),
    )
    .await?;
    assert_eq!(st, StatusCode::CREATED, "{pt}");
    assert_eq!(pt["action"]["kind"], "oncall-page-test");
    assert!(
        pt["action"]["command"]
            .as_str()
            .is_some_and(|c| c.contains("console-oncall-test"))
    );

    // Jobs rerun: unknown -> 404 OPS_NOT_FOUND
    let (st, _, nf) = send_json(
        &h.app,
        req_post(
            "/api/ops/v1/running/jobs/not-a-job/rerun",
            &h.operator_jwt,
            json!({}),
        ),
    )
    .await?;
    assert_eq!(st, StatusCode::NOT_FOUND, "{nf}");
    assert_eq!(nf["code"], "OPS_NOT_FOUND");
    let (st, _, rr) = send_json(
        &h.app,
        req_post(
            "/api/ops/v1/running/jobs/walg-backup/rerun",
            &h.operator_jwt,
            json!({}),
        ),
    )
    .await?;
    assert_eq!(st, StatusCode::CREATED, "{rr}");

    // Health separates internal SLOs and public StatusFeed
    let (st, _, health) = send_json(&h.app, req_get("/api/ops/v1/health", &h.operator_jwt)).await?;
    assert_eq!(st, StatusCode::OK, "{health}");
    assert!(health["internal_slos"].is_array() && health["public_status"].is_object());
    assert_eq!(health["public_status"]["revision"]["value"], 7);

    // Changes & Cmd drafts
    let (st, _, ch) = send_json(&h.app, req_get("/api/ops/v1/changes", &h.operator_jwt)).await?;
    assert_eq!(st, StatusCode::OK, "{ch}");
    assert!(ch["releases"].is_array() && ch["dora5"].is_object());
    for (path, payload) in [
        (
            "/api/ops/v1/changes/rollback",
            json!({"digest": DIGEST, "reason": "Regression"}),
        ),
        (
            "/api/ops/v1/changes/canary",
            json!({"decision": "hold", "reason": "Observe"}),
        ),
        (
            "/api/ops/v1/changes/freeze",
            json!({"freeze": true, "reason": "Window"}),
        ),
    ] {
        let (st, _, b) = send_json(&h.app, req_post(path, &h.operator_jwt, payload)).await?;
        assert_eq!(st, StatusCode::CREATED, "{path}: {b}");
    }

    // Promote signoff, feedback, request
    let (st, _, so) = send_json(
        &h.app,
        req_post(
            "/api/ops/v1/promote/signoff",
            &h.operator_jwt,
            json!({"digest": DIGEST, "verdict": "ready", "note": "Verified"}),
        ),
    )
    .await?;
    assert_eq!(st, StatusCode::CREATED, "{so}");
    let (st, _, fb) = send_json(&h.app, req_post("/api/ops/v1/promote/feedback", &h.operator_jwt, json!({"feedback_id": "fb-1", "digest": DIGEST, "severity": "P2", "disposition": "resolved", "note": "Done"}))).await?;
    assert_eq!(st, StatusCode::CREATED, "{fb}");
    let (st, _, pr) = send_json(
        &h.app,
        req_post(
            "/api/ops/v1/promote/request",
            &h.operator_jwt,
            json!({"digest": DIGEST, "bake": "normal"}),
        ),
    )
    .await?;
    assert_eq!(st, StatusCode::CREATED, "{pr}");
    let (st, _, pv) = send_json(&h.app, req_get("/api/ops/v1/promote", &h.operator_jwt)).await?;
    assert_eq!(st, StatusCode::OK, "{pv}");
    assert_eq!(pv["signoffs"].as_array().map(Vec::len), Some(1));

    // Recovery: RTO stays Unknown: Not measured; tenant rejected on drill; drill-at uses change.request.drill-at
    let (st, _, rec) = send_json(&h.app, req_get("/api/ops/v1/recovery", &h.operator_jwt)).await?;
    assert_eq!(st, StatusCode::OK, "{rec}");
    assert_eq!(rec["rto"]["state"], "Unknown");
    assert_eq!(rec["rto"]["reason"], "Not measured");
    let (st, _, _) = send_json(
        &h.app,
        req_post(
            "/api/ops/v1/recovery/backup",
            &h.operator_jwt,
            json!({"backup_type":"full","window":"now"}),
        ),
    )
    .await?;
    assert_eq!(st, StatusCode::CREATED);
    let (st, _, tenant_rej) = send_json(
        &h.app,
        req_post(
            "/api/ops/v1/recovery/drill",
            &h.operator_jwt,
            json!({"repo":"1","drill_type":"name","window":"now","tenant":"acme"}),
        ),
    )
    .await?;
    assert_eq!(st, StatusCode::BAD_REQUEST, "{tenant_rej}");
    let (st, _, drill) = send_json(
        &h.app,
        req_post(
            "/api/ops/v1/recovery/drill",
            &h.operator_jwt,
            json!({"repo":"1","drill_type":"time","target":"2026-11-23T00:00:00Z","window":"now"}),
        ),
    )
    .await?;
    assert_eq!(st, StatusCode::CREATED, "{drill}");
    assert_eq!(drill["action"]["kind"], "drill-at");
    assert!(
        drill["action"]["command"]
            .as_str()
            .is_some_and(|c| c.contains("drill-at"))
    );

    // Actions list reflects recorded Cmds
    let (st, _, acts) = send_json(&h.app, req_get("/api/ops/v1/actions", &h.operator_jwt)).await?;
    assert_eq!(st, StatusCode::OK, "{acts}");
    assert!(acts["actions"].as_array().is_some_and(|a| a.len() >= 6));

    // Runbooks list + read + traversal + symlink refusal
    let (st, _, rbs) = send_json(&h.app, req_get("/api/ops/v1/runbooks", &h.operator_jwt)).await?;
    assert_eq!(st, StatusCode::OK, "{rbs}");
    let (st, _, rb) = send_json(
        &h.app,
        req_get("/api/ops/v1/runbooks/RUNBOOK.md", &h.operator_jwt),
    )
    .await?;
    assert_eq!(st, StatusCode::OK, "{rb}");
    assert!(
        rb["doc"]["content"]
            .as_str()
            .is_some_and(|c| c.contains("Primary Runbook"))
    );
    let (st, _, trav) = send_json(
        &h.app,
        req_get(
            "/api/ops/v1/runbooks/..%2F..%2Fetc%2Fpasswd",
            &h.operator_jwt,
        ),
    )
    .await?;
    assert_eq!(st, StatusCode::NOT_FOUND, "{trav}");
    assert_eq!(trav["code"], "OPS_RUNBOOK_NOT_FOUND");
    let target = h.dirs.root.join("outside.md");
    fs::write(&target, "# Secret")?;
    symlink(&target, h.dirs.config.join("runbooks/link.md"))?;
    let (st, _, sym) = send_json(
        &h.app,
        req_get("/api/ops/v1/runbooks/link.md", &h.operator_jwt),
    )
    .await?;
    assert_eq!(st, StatusCode::NOT_FOUND, "{sym}");
    assert_eq!(sym["code"], "OPS_RUNBOOK_NOT_FOUND");
    Ok(())
}

#[tokio::test]
async fn every_post_and_delete_route_refuses_missing_origin_with_origin_refused() -> TestResult {
    let h = build_harness(Some(datetime!(2026-11-23 00:00:00 UTC))).await?;
    let mutations = [
        (
            Method::POST,
            format!("/api/ops/v1/alerts/{}/ack", h.page_key),
        ),
        (Method::POST, "/api/ops/v1/silences".into()),
        (Method::DELETE, "/api/ops/v1/silences/sil-1".into()),
        (Method::POST, "/api/ops/v1/oncall/page-test".into()),
        (
            Method::POST,
            "/api/ops/v1/running/jobs/walg-backup/rerun".into(),
        ),
        (Method::POST, "/api/ops/v1/incidents".into()),
        (Method::POST, "/api/ops/v1/incidents/inc-1/events".into()),
        (
            Method::POST,
            "/api/ops/v1/incidents/inc-1/public-draft".into(),
        ),
        (Method::POST, "/api/ops/v1/changes/rollback".into()),
        (Method::POST, "/api/ops/v1/changes/canary".into()),
        (Method::POST, "/api/ops/v1/changes/freeze".into()),
        (Method::POST, "/api/ops/v1/promote/signoff".into()),
        (Method::POST, "/api/ops/v1/promote/feedback".into()),
        (Method::POST, "/api/ops/v1/promote/request".into()),
        (Method::POST, "/api/ops/v1/recovery/backup".into()),
        (Method::POST, "/api/ops/v1/recovery/drill".into()),
        (Method::POST, "/api/ops/v1/obligations".into()),
        (Method::POST, "/api/ops/v1/obligations/obl-1/events".into()),
    ];
    for (method, path) in mutations {
        let req = Request::builder()
            .method(method)
            .uri(&path)
            .header("Cf-Access-Jwt-Assertion", &h.operator_jwt)
            .body(Body::empty())?;
        let (st, hdrs, err) = send_json(&h.app, req).await?;
        assert_eq!(st, StatusCode::FORBIDDEN, "{path}");
        assert_eq!(err["code"], "origin_refused", "{path}");
        assert_no_store_no_cors(&hdrs);
    }
    Ok(())
}
