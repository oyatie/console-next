// SPDX-License-Identifier: LicenseRef-Proprietary
use std::fs;
use std::os::unix::fs::PermissionsExt;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{Value, json};
use time::{OffsetDateTime, macros::datetime};

#[path = "obligations_http_api/launch_gate.rs"]
mod launch_gate;
mod oc1_support;
use oc1_support::{assert_no_store_no_cors, build_harness, req_get, req_post, send_json};

type TestResult = Result<(), Box<dyn std::error::Error>>;

const SYNTHETIC_ITEMS_JSON: &str = include_str!("../../domain/tests/fixtures/obligations.json");

#[tokio::test]
async fn obligations_seed_transitions_home_gating_and_sse() -> TestResult {
    let fixed_now: OffsetDateTime = datetime!(2026-11-23 00:00:00 UTC);
    let h = build_harness(Some(fixed_now)).await?;
    let mut sse_rx = h.state.tx.subscribe();

    let fixture: Value = serde_json::from_str(SYNTHETIC_ITEMS_JSON)?;
    let items = fixture["items"].as_array().ok_or("items array missing")?;
    assert_eq!(items.len(), 31);

    let mut opened_ids = Vec::with_capacity(31);
    for (idx, item) in items.iter().enumerate() {
        let title = item["title"].as_str().ok_or("title missing")?;
        assert!(
            title.starts_with("Synthetic "),
            "must not seed private entries: {title}"
        );
        let mut req_val = item.clone();
        if idx == 0 {
            req_val["due"] = json!("2026-11-25"); // due soon within 7 days
        }
        let (st, hdrs, body) = send_json(
            &h.app,
            req_post("/api/ops/v1/obligations", &h.operator_jwt, req_val),
        )
        .await?;
        assert_eq!(st, StatusCode::CREATED, "{body}");
        assert_no_store_no_cors(&hdrs);
        opened_ids.push(body["id"].as_str().ok_or("id missing")?.to_owned());
    }

    // SSE emitted obligation.changed + home.changed.
    let mut saw_obl = false;
    let mut saw_home = false;
    while let Ok(ev) = sse_rx.try_recv() {
        let s = serde_json::to_string(&ev)?;
        if s.contains("\"type\":\"obligation.changed\"") {
            saw_obl = true;
        } else if s.contains("\"type\":\"home.changed\"") {
            saw_home = true;
        }
    }
    assert!(
        saw_obl && saw_home,
        "expected obligation.changed + home.changed SSE events"
    );

    // List all 31 + verify launch readiness Degraded; item #0 triggers due worklist.
    let (st, _, list_body) =
        send_json(&h.app, req_get("/api/ops/v1/obligations", &h.operator_jwt)).await?;
    assert_eq!(st, StatusCode::OK, "{list_body}");
    assert_eq!(list_body["items"].as_array().map(Vec::len), Some(31));
    assert_eq!(list_body["launch_readiness"]["worst"], "Degraded");

    // /home includes launch_readiness + Obligation worklist + Verified evidence count increment when obligation.read granted.
    let (st, _, home_op) = send_json(&h.app, req_get("/api/ops/v1/home", &h.operator_jwt)).await?;
    assert_eq!(st, StatusCode::OK);
    assert!(home_op.get("launch_readiness").is_some());
    assert!(
        home_op["worklist"]
            .as_array()
            .is_some_and(|w| w.iter().any(|x| x["kind"] == "obligation"))
    );

    // /home omits obligation data for operator lacking obligation.read, and /obligations denies 403.
    let (st, _, home_lim) =
        send_json(&h.app, req_get("/api/ops/v1/home", &h.home_only_jwt)).await?;
    assert_eq!(st, StatusCode::OK);
    assert!(home_lim.get("launch_readiness").is_none());
    assert!(
        !home_lim["worklist"]
            .as_array()
            .is_some_and(|w| w.iter().any(|x| x["kind"] == "obligation"))
    );
    assert_eq!(
        home_op["evidence"]["counts"]["Verified"].as_u64(),
        home_lim["evidence"]["counts"]["Verified"]
            .as_u64()
            .map(|n| n + 1),
    );
    let (st, _, deny_body) =
        send_json(&h.app, req_get("/api/ops/v1/obligations", &h.home_only_jwt)).await?;
    assert_eq!(st, StatusCode::FORBIDDEN);
    assert_eq!(deny_body["code"], "OPS_ACTION_DENIED");

    // Transitions: in_review -> redated -> done / waived across all 31 -> launch readiness Normal.
    let first = &opened_ids[0];
    let (st, _, _) = send_json(
        &h.app,
        req_post(
            &format!("/api/ops/v1/obligations/{first}/events"),
            &h.operator_jwt,
            json!({"event":"in_review","fields":{"note":"Assigned"}}),
        ),
    )
    .await?;
    assert_eq!(st, StatusCode::OK);
    let (st, _, _) = send_json(
        &h.app,
        req_post(
            &format!("/api/ops/v1/obligations/{first}/events"),
            &h.operator_jwt,
            json!({"event":"redated","fields":{"due":"2026-11-26","reason":"Moved"}}),
        ),
    )
    .await?;
    assert_eq!(st, StatusCode::OK);
    launch_gate::record_decisions(&h, &opened_ids, items).await?;
    let (st, _, list_after) =
        send_json(&h.app, req_get("/api/ops/v1/obligations", &h.operator_jwt)).await?;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(list_after["launch_readiness"]["worst"], "Healthy");

    let (st, _, detail) = send_json(
        &h.app,
        req_get(&format!("/api/ops/v1/obligations/{first}"), &h.operator_jwt),
    )
    .await?;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(
        detail["history"].as_array().map(Vec::len),
        Some(if items[0]["kind"] == "launch-gate" {
            5
        } else {
            4
        })
    );
    Ok(())
}

#[tokio::test]
async fn obligations_validation_origin_chain_tamper_and_readonly_refusals() -> TestResult {
    let h = build_harness(Some(datetime!(2026-11-23 00:00:00 UTC))).await?;
    // Invalid input -> 400 OPS_OBLIGATION_INVALID
    let (st, _, bad) = send_json(
        &h.app,
        req_post(
            "/api/ops/v1/obligations",
            &h.operator_jwt,
            json!({"kind":"bogus","reviewer_role":"owner","title":"x"}),
        ),
    )
    .await?;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    assert_eq!(bad["code"], "OPS_OBLIGATION_INVALID");

    // Origin guard -> 403 origin_refused
    let no_origin = Request::builder()
        .method("POST")
        .uri("/api/ops/v1/obligations")
        .header("Cf-Access-Jwt-Assertion", &h.operator_jwt)
        .header("Content-Type", "application/json")
        .body(Body::from(
            "{\"kind\":\"drill\",\"reviewer_role\":\"owner\",\"title\":\"x\"}",
        ))?;
    let (st, _, org_err) = send_json(&h.app, no_origin).await?;
    assert_eq!(st, StatusCode::FORBIDDEN);
    assert_eq!(org_err["code"], "origin_refused");

    // Open one, verify incomplete signoff -> 422, complete -> 200, second write -> 409 Final, unknown -> 404
    let (st, _, created) = send_json(
        &h.app,
        req_post(
            "/api/ops/v1/obligations",
            &h.operator_jwt,
            json!({"kind":"drill","reviewer_role":"owner","title":"Synthetic drill"}),
        ),
    )
    .await?;
    assert_eq!(st, StatusCode::CREATED);
    let id = created["id"].as_str().ok_or("id missing")?.to_owned();

    let (st, _, inc) = send_json(&h.app, req_post(&format!("/api/ops/v1/obligations/{id}/events"), &h.operator_jwt, json!({"event":"done","fields":{"evidence_ref":"r","signer":" ","signed_on":"2026-11-23"}}))).await?;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(inc["code"], "OPS_OBLIGATION_INCOMPLETE");

    let (st, _, _) = send_json(&h.app, req_post(&format!("/api/ops/v1/obligations/{id}/events"), &h.operator_jwt, json!({"event":"done","fields":{"evidence_ref":"r","signer":"Owner","signed_on":"2026-11-23"}}))).await?;
    assert_eq!(st, StatusCode::OK);

    let (st, _, fin) = send_json(
        &h.app,
        req_post(
            &format!("/api/ops/v1/obligations/{id}/events"),
            &h.operator_jwt,
            json!({"event":"in_review","fields":{}}),
        ),
    )
    .await?;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(fin["code"], "OPS_OBLIGATION_FINAL");

    let (st, _, nf) = send_json(
        &h.app,
        req_get("/api/ops/v1/obligations/does-not-exist", &h.operator_jwt),
    )
    .await?;
    assert_eq!(st, StatusCode::NOT_FOUND);
    assert_eq!(nf["code"], "OPS_OBLIGATION_NOT_FOUND");

    // Tamper 00000001.json -> GET returns 200 Unknown, POST returns 503 OPS_RECORD_CHAIN_BROKEN, /home still 200!
    let rec1 = h.dirs.records.join("obligations/00000001.json");
    let raw = fs::read_to_string(&rec1)?;
    fs::write(&rec1, raw.replace("Synthetic drill", "Tampered drill"))?;

    let (st, _, broken_list) =
        send_json(&h.app, req_get("/api/ops/v1/obligations", &h.operator_jwt)).await?;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(broken_list["count"]["state"], "Unknown");
    assert!(
        broken_list["count"]["reason"]
            .as_str()
            .is_some_and(|r| r.contains("record chain broken"))
    );
    assert_eq!(broken_list["sources"][0]["state"], "Unknown");
    let (st, _, broken_detail) = send_json(
        &h.app,
        req_get(&format!("/api/ops/v1/obligations/{id}"), &h.operator_jwt),
    )
    .await?;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(broken_detail["sources"][0]["state"], "Unknown");
    assert!(
        broken_detail["sources"][0]["reason"]
            .as_str()
            .is_some_and(|r| r.contains("record chain broken"))
    );
    let (st, _, broken_post) = send_json(
        &h.app,
        req_post(
            "/api/ops/v1/obligations",
            &h.operator_jwt,
            json!({"kind":"drill","reviewer_role":"owner","title":"Blocked"}),
        ),
    )
    .await?;
    assert_eq!(st, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(broken_post["code"], "OPS_RECORD_CHAIN_BROKEN");
    let (st, _, home_ok) = send_json(&h.app, req_get("/api/ops/v1/home", &h.operator_jwt)).await?;
    assert_eq!(st, StatusCode::OK);
    assert!(home_ok["worklist"].is_array());
    assert!(home_ok["evidence"]["sources"].as_array().is_some_and(|s| {
        s.iter()
            .any(|x| x["name"] == "obligations" && x["state"] == "Unknown")
    }));

    // Read-only spool dir -> 503 OPS_RECORD_WRITE_FAILED
    let ro_root = std::env::temp_dir().join(format!("console-ops-ro-{}", uuid::Uuid::new_v4()));
    let obl_dir = ro_root.join("obligations");
    fs::create_dir_all(&obl_dir)?;
    fs::set_permissions(&obl_dir, fs::Permissions::from_mode(0o555))?;
    let mut ro_state = h.state.clone();
    ro_state.obligations =
        Some(console_ops_adapter_fs::SpoolSet::open_resilient(&ro_root).obligations);
    let ro_app = console_ops_rest::router(ro_state, None);
    let (st, _, wf) = send_json(
        &ro_app,
        req_post(
            "/api/ops/v1/obligations",
            &h.operator_jwt,
            json!({"kind":"drill","reviewer_role":"owner","title":"Readonly"}),
        ),
    )
    .await?;
    let _ = fs::set_permissions(&obl_dir, fs::Permissions::from_mode(0o755));
    let _ = fs::remove_dir_all(&ro_root);
    // Note: if running as root in some containers chmod 0555 can still write; assert only when failed
    if st != StatusCode::CREATED {
        assert_eq!(st, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(wf["code"], "OPS_RECORD_WRITE_FAILED");
    }
    Ok(())
}
