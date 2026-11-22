// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(dead_code)]
use std::collections::BTreeMap;
use std::fs;
use std::num::NonZeroU64;
use std::sync::{Arc, Mutex};
use std::time::Duration as StdDuration;

use aws_lc_rs::digest::{SHA256, digest};
use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use console_ops_application::{Alert, AlertState, AlertStatus, CockpitEvaluator, SourcePorts};
use console_ops_domain::bundle::{AccessSettings, validate_oncall_json};
use console_ops_rest::access_jwt::AccessJwtVerifier;
use console_ops_rest::operators::{OperatorRegistry, VALID_ACTIONS};
use console_ops_rest::state::OpsRestState;
use console_ops_rest::{FsBackendPaths, attach_fs_backends, router};
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};

pub mod mocks;
pub use mocks::{MockAmWriter, MockStatusFeed, Oc1Vm, TempRoot};

#[path = "../support/mod.rs"]
pub mod base;

pub use base::{
    AUD, ISSUER, JwtSigner, MockSources, OPERATOR_EMAIL, ORIGIN, READ_HOME_ONLY_EMAIL, test_bundle,
};

pub struct Oc1Harness {
    pub dirs: TempRoot,
    pub state: OpsRestState,
    pub app: axum::Router,
    pub signer: JwtSigner,
    pub am_writer: Arc<MockAmWriter>,
    pub now: OffsetDateTime,
    pub operator_jwt: String,
    pub home_only_jwt: String,
    pub page_key: String,
    pub watchdog_key: String,
    pub ticket_key: String,
}

pub async fn build_harness(
    fixed_now: Option<OffsetDateTime>,
) -> Result<Oc1Harness, Box<dyn std::error::Error>> {
    let signer = JwtSigner::generate()?;
    let (comp, settings, _) = test_bundle()?;
    let now = fixed_now.unwrap_or_else(OffsetDateTime::now_utc);
    let from = (now - Duration::hours(2)).format(&Rfc3339)?;
    let until = (now + Duration::hours(2)).format(&Rfc3339)?;
    let all_grants: Vec<Value> = VALID_ACTIONS
        .iter()
        .map(|a| json!({"action": a, "from": from, "until": until}))
        .collect();
    let operators_json = json!([
        {
            "person": "00000000-0000-4000-8000-000000000001",
            "email_sha256": hex::encode(digest(&SHA256, OPERATOR_EMAIL.as_bytes())),
            "grants": all_grants
        },
        {
            "person": "00000000-0000-4000-8000-000000000002",
            "email_sha256": hex::encode(digest(&SHA256, READ_HOME_ONLY_EMAIL.as_bytes())),
            "grants": [
                {"action": "read.me", "from": from, "until": until},
                {"action": "read.home", "from": from, "until": until}
            ]
        }
    ])
    .to_string();

    let (dirs, rx) = TempRoot::new()?;
    fs::write(
        dirs.config.join("runbooks/RUNBOOK.md"),
        "# Primary Runbook\n## Alert Triage\nCheck metrics.\n",
    )?;
    fs::write(
        dirs.config.join("runbooks/backup.md"),
        "# Backup Recovery\n## Base Backup\nVerify wal-g.\n",
    )?;
    let hex64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    let digest_dir = format!("sha256:{hex64}");
    fs::create_dir_all(dirs.releases.join(&digest_dir))?;
    fs::write(
        dirs.releases.join(&digest_dir).join("gates.json"),
        json!({
            "_type": "https://in-toto.io/Statement/v1",
            "predicateType": "https://cosskorea.com/attestations/console-gates/v1",
            "subject": [{"digest": {"sha256": hex64}}],
            "predicate": {
                "inputs": {"backend": "1234"},
                "gates": [{"name": "smoke", "result": "pass"}],
                "runner": {"kind": "gha", "url": null},
                "approver": null,
                "bake": "normal"
            }
        })
        .to_string(),
    )?;
    let compact = format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    );
    fs::write(
        dirs.state.join("deploy-history.log"),
        format!("{compact} ok from=none to={digest_dir} promoted staging\n"),
    )?;
    let oncall = validate_oncall_json(
        &json!({
            "version": 1,
            "mode": "single-operator",
            "display_status": "Single operator on call",
            "timezone": "Asia/Seoul",
            "rotation": {
                "primary_person": "00000000-0000-4000-8000-000000000001",
                "backup_person": null,
                "handoff_weekday": "Mon",
                "handoff_hour_local": 9
            },
            "escalation": {
                "ack_timeout_s": 300,
                "repeat_interval_s": 900,
                "out_of_hours_policy": "sev1-symptoms-only",
                "daily_page_budget": 2
            },
            "synthetic_page_test": {
                "enabled": true,
                "schedule": "weekly",
                "weekday": "Wed",
                "hour_utc": 2,
                "max_delivery_lag_s": 120
            }
        })
        .to_string(),
        Some(&["00000000-0000-4000-8000-000000000001"]),
    )?;

    let mk_alert = |fp: &str, name: &str, sev: &str, sum: &str| Alert {
        fingerprint: fp.into(),
        labels: [
            ("alertname".into(), name.into()),
            ("severity".into(), sev.into()),
            ("component".into(), "api".into()),
        ]
        .into(),
        annotations: [("summary".into(), sum.into())].into(),
        starts_at: now - Duration::minutes(5),
        ends_at: now + Duration::hours(1),
        status: AlertStatus {
            state: AlertState::Active,
            silenced_by: vec![],
            inhibited_by: vec![],
        },
    };
    let sources = Arc::new(MockSources {
        alerts: Mutex::new(vec![
            mk_alert("fp-page", "HighLatency", "page", "Latency high"),
            mk_alert("fp-wd", "Watchdog", "ticket", "Pipeline deadmanswitch"),
            mk_alert("fp-tkt", "DiskSoon", "ticket", "Disk filling"),
        ]),
    });
    let vm = Arc::new(Oc1Vm { now });
    let boot = now - Duration::seconds(61);
    let mut eval = CockpitEvaluator::new(
        SourcePorts {
            alertmanager: sources.clone(),
            vmalert: sources.clone(),
            victoriametrics: vm.clone(),
        },
        comp,
        settings.clone(),
        boot,
    );
    eval.set_access_jwks_status(Some(boot), None);
    eval.tick(now).await;
    let initial = eval.evaluate(now);
    let registry = Arc::new(OperatorRegistry::from_json(&operators_json)?);
    let access: AccessSettings = settings.access.clone();
    let jwt = Arc::new(AccessJwtVerifier::from_jwks_json(
        &access,
        &signer.jwks_json,
        now,
    )?);
    let am_writer = Arc::new(MockAmWriter::default());
    let base_state = OpsRestState::new(registry, jwt, initial, ORIGIN, rx)
        .with_clock(Arc::new(move || now))
        .with_settings(settings)
        .with_oncall(oncall)
        .with_bundle_sha("bundle-sha-fixture")
        .with_am_writer(am_writer.clone())
        .with_status_feed(Arc::new(MockStatusFeed { now }))
        .with_victoriametrics(
            vm,
            "fixture".into(),
            NonZeroU64::new(60).unwrap_or(NonZeroU64::MIN),
        );
    let state = attach_fs_backends(
        base_state,
        FsBackendPaths {
            config_dir: &dirs.config,
            records_dir: Some(&dirs.records),
            releases_dir: Some(&dirs.releases),
            state_dir: Some(&dirs.state),
        },
        7,
    );
    let app = router(state.clone(), Some(StdDuration::from_secs(5)));
    let operator_jwt = signer.sign(OPERATOR_EMAIL, AUD, ISSUER, 300, None)?;
    let home_only_jwt = signer.sign(READ_HOME_ONLY_EMAIL, AUD, ISSUER, 300, None)?;
    let (_, _, alerts_body) = send_json(
        &app,
        Request::builder()
            .uri("/api/ops/v1/alerts")
            .header("Cf-Access-Jwt-Assertion", &operator_jwt)
            .body(Body::empty())?,
    )
    .await?;
    let groups = alerts_body["groups"].as_array().ok_or("missing groups")?;
    let key_of = |name: &str| {
        groups
            .iter()
            .find(|g| g["alertname"] == name)
            .and_then(|g| g["key"].as_str())
            .unwrap_or_default()
            .to_owned()
    };
    let (page_key, watchdog_key, ticket_key) = (
        key_of("HighLatency"),
        key_of("Watchdog"),
        key_of("DiskSoon"),
    );
    Ok(Oc1Harness {
        dirs,
        state,
        app,
        signer,
        am_writer,
        now,
        operator_jwt,
        home_only_jwt,
        page_key,
        watchdog_key,
        ticket_key,
    })
}

pub async fn send_json(
    app: &axum::Router,
    req: Request<Body>,
) -> Result<(StatusCode, axum::http::HeaderMap, Value), Box<dyn std::error::Error>> {
    use tower::ServiceExt;
    let resp = app.clone().oneshot(req).await?;
    let status = resp.status();
    let headers = resp.headers().clone();
    let bytes = to_bytes(resp.into_body(), 1024 * 1024).await?;
    let val = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)
            .unwrap_or(Value::String(String::from_utf8_lossy(&bytes).into()))
    };
    Ok((status, headers, val))
}

pub fn req_get(uri: &str, jwt: &str) -> Request<Body> {
    Request::builder()
        .uri(uri)
        .header("Cf-Access-Jwt-Assertion", jwt)
        .body(Body::empty())
        .unwrap_or_else(|_| Request::new(Body::empty()))
}

pub fn req_post(uri: &str, jwt: &str, body: Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(uri)
        .header("Cf-Access-Jwt-Assertion", jwt)
        .header("Origin", ORIGIN)
        .header("Sec-Fetch-Site", "same-origin")
        .header("Content-Type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap_or_else(|_| Request::new(Body::empty()))
}

pub fn req_delete(uri: &str, jwt: &str) -> Request<Body> {
    Request::builder()
        .method("DELETE")
        .uri(uri)
        .header("Cf-Access-Jwt-Assertion", jwt)
        .header("Origin", ORIGIN)
        .header("Sec-Fetch-Site", "same-origin")
        .body(Body::empty())
        .unwrap_or_else(|_| Request::new(Body::empty()))
}

pub fn assert_no_store_no_cors(headers: &axum::http::HeaderMap) {
    assert_eq!(headers["cache-control"], "no-store");
    assert!(!headers.contains_key("set-cookie"));
    for name in headers.keys() {
        assert!(!name.as_str().starts_with("access-control-"), "{name}");
    }
}

pub fn _keep_btree(_: BTreeMap<String, String>) {}
