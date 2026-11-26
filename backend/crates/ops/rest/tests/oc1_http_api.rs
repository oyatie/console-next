// SPDX-License-Identifier: LicenseRef-Proprietary
use axum::http::StatusCode;
use console_ops_rest::operators::VALID_ACTIONS;
use serde_json::{Value, json};
use time::{Duration, format_description::well_known::Rfc3339, macros::datetime};

mod oc1_support;
use oc1_support::{
    AUD, ISSUER, OPERATOR_EMAIL, assert_no_store_no_cors, build_harness, req_delete, req_get,
    req_post, send_json,
};

type TestResult = Result<(), Box<dyn std::error::Error>>;

async fn post_silence(
    h: &oc1_support::Oc1Harness,
    alertname: &str,
    hrs: i64,
    comment: &str,
    group_key: Option<&str>,
) -> Result<(StatusCode, Value), Box<dyn std::error::Error>> {
    let mut body = json!({
        "matchers": [{"name":"alertname","value":alertname,"is_regex":false}],
        "ends_at": (h.now + Duration::hours(hrs)).format(&Rfc3339)?,
        "comment": comment,
    });
    if let Some(k) = group_key {
        body["group_key"] = json!(k);
    }
    let (st, _, val) = send_json(
        &h.app,
        req_post("/api/ops/v1/silences", &h.operator_jwt, body),
    )
    .await?;
    Ok((st, val))
}

async fn post_inc_event(
    h: &oc1_support::Oc1Harness,
    id: &str,
    body: Value,
) -> Result<(StatusCode, Value), Box<dyn std::error::Error>> {
    let path = format!("/api/ops/v1/incidents/{id}/events");
    let (st, _, val) = send_json(&h.app, req_post(&path, &h.operator_jwt, body)).await?;
    Ok((st, val))
}

#[tokio::test]
async fn me_returns_all_54_cedar_actions_and_normalizes_email_trim_case() -> TestResult {
    let h = build_harness(Some(datetime!(2026-11-23 00:00:00 UTC))).await?;
    assert_eq!(VALID_ACTIONS.len(), 54);
    assert!(
        h.state
            .registry
            .authorize(
                &format!("  {}  ", OPERATOR_EMAIL.to_uppercase()),
                "read.me",
                h.now
            )
            .is_ok()
    );
    let upper_jwt = h
        .signer
        .sign(&OPERATOR_EMAIL.to_uppercase(), AUD, ISSUER, 300, None)?;
    let (st, hdrs, body) = send_json(&h.app, req_get("/api/ops/v1/me", &upper_jwt)).await?;
    assert_eq!(st, StatusCode::OK, "{body}");
    assert_no_store_no_cors(&hdrs);
    let actions = body["allowed_actions"]
        .as_array()
        .ok_or("allowed_actions must be array")?;
    assert_eq!(actions.len(), 54);
    for a in VALID_ACTIONS {
        assert!(actions.iter().any(|x| x == a), "missing {a} from /me");
    }
    Ok(())
}

#[tokio::test]
async fn alerts_ack_and_silence_spool_first_watchdog_ttl_and_am_failure() -> TestResult {
    let h = build_harness(Some(datetime!(2026-11-23 00:00:00 UTC))).await?;
    // Ack
    let (st, hdrs, ack) = send_json(
        &h.app,
        req_post(
            &format!("/api/ops/v1/alerts/{}/ack", h.page_key),
            &h.operator_jwt,
            json!({"note":"Checking"}),
        ),
    )
    .await?;
    assert_eq!(st, StatusCode::OK, "{ack}");
    assert_no_store_no_cors(&hdrs);
    assert_eq!(ack["record"]["group_key"], h.page_key);

    // Watchdog unsilenceable (exact and case-insensitive) -> 422 OPS_WATCHDOG_UNSILENCEABLE
    for (wd_name, key) in [
        ("Watchdog", Some(h.watchdog_key.as_str())),
        ("watchdog", Some(h.watchdog_key.as_str())),
        ("WATCHDOG", None),
    ] {
        let (st, wd) = post_silence(&h, wd_name, 1, "Silence deadman switch", key).await?;
        assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY, "{wd_name}: {wd}");
        assert_eq!(wd["code"], "OPS_WATCHDOG_UNSILENCEABLE", "{wd_name}");
    }

    // Short comment -> 400 OPS_SILENCE_INVALID
    let (st, short_c) = post_silence(&h, "HighLatency", 1, "too short", Some(&h.page_key)).await?;
    assert_eq!(st, StatusCode::BAD_REQUEST, "{short_c}");
    assert_eq!(short_c["code"], "OPS_SILENCE_INVALID");

    // Page TTL > 4h and Ticket TTL > 72h -> 400 OPS_SILENCE_TTL_EXCEEDED
    for (key, name, hrs) in [
        (&h.page_key, "HighLatency", 5),
        (&h.ticket_key, "DiskSoon", 73),
    ] {
        let (st, ttl_err) =
            post_silence(&h, name, hrs, "Long maintenance window", Some(key)).await?;
        assert_eq!(st, StatusCode::BAD_REQUEST, "{ttl_err}");
        assert_eq!(ttl_err["code"], "OPS_SILENCE_TTL_EXCEEDED");
    }

    // Mismatched Ticket/Watchdog group_key or omitted group_key must not allow 72h Page silence
    for bad_key in [Some(h.ticket_key.as_str()), Some(h.watchdog_key.as_str())] {
        let (st, bypass) =
            post_silence(&h, "HighLatency", 72, "Long maintenance window", bad_key).await?;
        assert_eq!(st, StatusCode::BAD_REQUEST, "{bypass}");
        assert_eq!(bypass["code"], "OPS_SILENCE_INVALID");
    }
    let (st, no_key) = post_silence(&h, "HighLatency", 72, "Long maintenance window", None).await?;
    assert_eq!(st, StatusCode::BAD_REQUEST, "{no_key}");
    assert_eq!(no_key["code"], "OPS_SILENCE_TTL_EXCEEDED");

    // AM upstream error -> 502 OPS_UPSTREAM_FAILED
    h.am_writer
        .fail_next
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let (st, am_err) = post_silence(
        &h,
        "HighLatency",
        2,
        "Upstream failure test",
        Some(&h.page_key),
    )
    .await?;
    assert_eq!(st, StatusCode::BAD_GATEWAY, "{am_err}");
    assert_eq!(am_err["code"], "OPS_UPSTREAM_FAILED");

    // Happy create + delete silence
    let (st, created) = post_silence(
        &h,
        "HighLatency",
        2,
        "Valid maintenance silence",
        Some(&h.page_key),
    )
    .await?;
    assert_eq!(st, StatusCode::CREATED, "{created}");
    let sid = created["silence_id"].as_str().ok_or("silence_id missing")?;
    let (st, _, deleted) = send_json(
        &h.app,
        req_delete(&format!("/api/ops/v1/silences/{sid}"), &h.operator_jwt),
    )
    .await?;
    assert_eq!(st, StatusCode::OK, "{deleted}");
    assert_eq!(deleted["deleted"], true);
    Ok(())
}

#[tokio::test]
async fn incidents_optimistic_concurrency_postmortem_public_draft_and_home_merge() -> TestResult {
    let h = build_harness(Some(datetime!(2026-11-23 00:00:00 UTC))).await?;
    let (st, _, inc) = send_json(
        &h.app,
        req_post(
            "/api/ops/v1/incidents",
            &h.operator_jwt,
            json!({
                "title": "API outage",
                "sev": "SEV1",
                "lead": "operator",
                "affected_components": ["api"],
                "personal_data_impact": "unknown",
                "intrusion": true,
                "discovered_at": "2026-11-23T00:00:00Z"
            }),
        ),
    )
    .await?;
    assert_eq!(st, StatusCode::CREATED, "{inc}");
    let id = inc["incident"]["id"]
        .as_str()
        .ok_or("incident id")?
        .to_owned();
    assert_eq!(inc["incident"]["head_seq"], 1);
    assert!(
        !inc["incident"]["legal_clocks"]
            .as_array()
            .is_none_or(Vec::is_empty)
    );

    // Reject expected_seq == 0 + declared and forged public_drafted on /events -> 400 OPS_INCIDENT_INVALID
    let (st, bad_decl) = post_inc_event(
        &h,
        "INC-0099",
        json!({"expected_seq": 0, "event": "declared", "fields": {
            "title": "Injected", "sev": "SEV1", "affected_components": ["api"],
            "personal_data_impact": "no", "discovered_at": "2026-11-23T00:00:00Z"
        }}),
    )
    .await?;
    assert_eq!(st, StatusCode::BAD_REQUEST, "{bad_decl}");
    assert_eq!(bad_decl["code"], "OPS_INCIDENT_INVALID");
    let (st, bad_draft) = post_inc_event(
        &h,
        &id,
        json!({"expected_seq": 1, "event": "public_drafted", "fields": {
            "draft": {"stage": "Investigating", "components": ["api"], "message_ko": "x", "message_en": "x", "rev": 1},
            "action_id": "forged"
        }}),
    )
    .await?;
    assert_eq!(st, StatusCode::BAD_REQUEST, "{bad_draft}");
    assert_eq!(bad_draft["code"], "OPS_INCIDENT_INVALID");

    // Wrong expected_seq -> 409 OPS_INCIDENT_CONFLICT
    let (st, conf) = post_inc_event(
        &h,
        &id,
        json!({"expected_seq": 99, "event": "note_added", "fields": {"note": "Mitigated"}}),
    )
    .await?;
    assert_eq!(st, StatusCode::CONFLICT, "{conf}");
    assert_eq!(conf["code"], "OPS_INCIDENT_CONFLICT");

    // SEV1 resolve without postmortem -> 409 OPS_POSTMORTEM_REQUIRED
    let (st, pm_req) = post_inc_event(
        &h,
        &id,
        json!({"prev": 1, "event": "resolved", "fields": {"summary": "Fixed"}}),
    )
    .await?;
    assert_eq!(st, StatusCode::CONFLICT, "{pm_req}");
    assert_eq!(pm_req["code"], "OPS_POSTMORTEM_REQUIRED");

    // Public draft records status publish Cmd handoff
    let (st, _, draft) = send_json(
        &h.app,
        req_post(
            &format!("/api/ops/v1/incidents/{id}/public-draft"),
            &h.operator_jwt,
            json!({
                "stage": "Investigating",
                "components": ["api"],
                "message_ko": "Investigating incident",
                "message_en": "Investigating incident",
                "rev": 1
            }),
        ),
    )
    .await?;
    assert_eq!(st, StatusCode::CREATED, "{draft}");
    assert!(
        draft["action"]["command"]
            .as_str()
            .is_some_and(|c| c.contains("tb status publish"))
    );

    // Link postmortem then resolve
    let (st, pm) = post_inc_event(
        &h,
        &id,
        json!({"expected_seq": 2, "event": "postmortem_linked", "fields": {"postmortem_ref": "docs/pm/2026-11-23.md"}}),
    )
    .await?;
    assert_eq!(st, StatusCode::OK, "{pm}");
    let (st, res) = post_inc_event(
        &h,
        &id,
        json!({"expected_seq": 3, "event": "resolved", "fields": {"summary": "Fixed"}}),
    )
    .await?;
    assert_eq!(st, StatusCode::OK, "{res}");
    assert_eq!(res["incident"]["status"], "Resolved");

    // /home merges pending actions (under read.running) and open incidents (declare another open one)
    let (st, _, _) = send_json(
        &h.app,
        req_post(
            "/api/ops/v1/incidents",
            &h.operator_jwt,
            json!({
                "title": "Followup",
                "sev": "SEV3",
                "affected_components": ["api"],
                "personal_data_impact": "no",
                "discovered_at": "2026-11-23T00:00:00Z"
            }),
        ),
    )
    .await?;
    assert_eq!(st, StatusCode::CREATED);
    let (st, _, list) =
        send_json(&h.app, req_get("/api/ops/v1/incidents", &h.operator_jwt)).await?;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(list["incidents"].as_array().map(Vec::len), Some(2));
    let (st, _, home) = send_json(&h.app, req_get("/api/ops/v1/home", &h.operator_jwt)).await?;
    assert_eq!(st, StatusCode::OK);
    let work = home["worklist"].as_array().ok_or("worklist array")?;
    assert!(work.iter().any(|w: &Value| {
        w["next"]["href"]
            .as_str()
            .is_some_and(|s| s.starts_with("/incidents/"))
    }));
    assert!(work.iter().any(|w: &Value| w["next"]["href"] == "/actions"));
    Ok(())
}

#[path = "oc1_http_api/silence_recovery.rs"]
mod silence_recovery;
