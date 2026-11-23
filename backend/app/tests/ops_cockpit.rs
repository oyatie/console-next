// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use console_app::{
    AppConfig, AppRole, AppState, DatabaseDependency, build_ops_router, build_router,
    install_metrics_recorder,
};
use console_ops_application::vmalert::VmalertSnapshot;
use console_ops_application::{
    Alertmanager, AlertmanagerSnapshot, AlertmanagerStatus, CockpitEvaluator, InstantSample,
    ScrapeTarget, SourceFuture, SourcePorts, VersionInfo, VictoriaMetrics, Vmalert,
};
use console_ops_rest::access_jwt::AccessJwtVerifier;
use console_ops_rest::init_ops_metrics;
use console_ops_rest::operators::OperatorRegistry;
use console_ops_rest::state::OpsRestState;
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::Generate;
use p256::pkcs8::{EncodePrivateKey, LineEnding};
use serde_json::json;
use time::OffsetDateTime;
use tokio::sync::watch;
use tower::ServiceExt;

type TestResult = Result<(), Box<dyn std::error::Error>>;

struct StubSources;
impl Alertmanager for StubSources {
    fn read(&self) -> SourceFuture<'_, AlertmanagerSnapshot> {
        Box::pin(async move {
            Ok(AlertmanagerSnapshot {
                alerts: vec![],
                silences: vec![],
                status: AlertmanagerStatus {
                    version_info: VersionInfo {
                        version: "0.27".into(),
                    },
                    uptime: OffsetDateTime::now_utc(),
                },
            })
        })
    }
}
impl Vmalert for StubSources {
    fn read(&self) -> SourceFuture<'_, VmalertSnapshot> {
        Box::pin(async move {
            Ok(VmalertSnapshot {
                groups: vec![],
                alerts: vec![],
            })
        })
    }
}
impl VictoriaMetrics for StubSources {
    fn query_instant(&self, _q: &str) -> SourceFuture<'_, Vec<InstantSample>> {
        Box::pin(async move { Ok(vec![]) })
    }
    fn targets(&self) -> SourceFuture<'_, Vec<ScrapeTarget>> {
        Box::pin(async move { Ok(vec![]) })
    }
}

fn temp_bundle() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let dir = std::env::temp_dir().join(format!("ops-bundle-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir)?;
    let key = SigningKey::generate();
    let pem = key.to_pkcs8_pem(LineEnding::LF)?;
    let enc = jsonwebtoken::EncodingKey::from_ec_pem(pem.as_bytes())?;
    let mut jwk = jsonwebtoken::jwk::Jwk::from_encoding_key(&enc, jsonwebtoken::Algorithm::ES256)?;
    jwk.common.key_id = Some("kid-1".to_owned());
    let jwks_path = dir.join("access-jwks.json");
    std::fs::write(&jwks_path, json!({"keys": [jwk]}).to_string())?;

    std::fs::write(
        dir.join("components.json"),
        json!({
            "app": {
                "group": "core", "host": "prod-1", "owner": "platform",
                "dashboard": "/running", "runbook": "https://example.invalid/rb",
                "source": "victoriametrics", "interval_s": 60
            }
        })
        .to_string(),
    )?;
    let src = json!({
        "url": "http://example.invalid", "producer": "fixture", "interval_s": 15,
        "read_limits": {"request_timeout_ms": 5000, "max_response_bytes": 4194304}
    });
    std::fs::write(dir.join("ops-settings.json"), json!({
        "sources": {"alertmanager": src, "vmalert": src, "victoriametrics": src},
        "access": {"team": "cosskorea", "aud": "ops-aud", "issuer": "https://cosskorea.cloudflareaccess.com", "jwks": jwks_path.display().to_string(), "interval_s": 3600},
        "origin": "https://ops.cosskorea.com",
        "thresholds": {"source_stale_multiplier": 2, "jwks_max_age_s": 3024000},
        "budgets": {"evaluate_interval_s": 15, "record_spool_max_files": 10000}
    }).to_string())?;
    std::fs::write(dir.join("operators.json"), json!([{
        "person": "00000000-0000-4000-8000-000000000001",
        "email_sha256": "a".repeat(64),
        "grants": [{"action": "read.home", "from": "2026-01-01T00:00:00Z", "until": "2027-01-01T00:00:00Z"}]
    }]).to_string())?;
    Ok(dir)
}

#[test]
fn ops_role_refuses_database_url_and_validates_bundle_with_exit_78() -> TestResult {
    let dir = temp_bundle()?;
    let err = match AppConfig::from_pairs([
        ("CONSOLE_APP_ROLE", "ops".to_owned()),
        ("CONSOLE_OPS_CONFIG_DIR", dir.display().to_string()),
        (
            "DATABASE_URL",
            "postgres://console_rt:secret@db/console".to_owned(),
        ),
    ]) {
        Ok(_) => return Err("ops role must refuse DATABASE_URL".into()),
        Err(e) => e,
    };
    assert!(err.to_string().contains("database-free"), "{err}");

    let cfg = AppConfig::from_pairs([
        ("CONSOLE_APP_ROLE", "ops".to_owned()),
        ("CONSOLE_OPS_CONFIG_DIR", dir.display().to_string()),
        (
            "CONSOLE_OPS_RECORDS_DIR",
            "/srv/console/ops-records".to_owned(),
        ),
    ])?;
    assert_eq!(cfg.role, AppRole::Ops);
    assert_eq!(cfg.service_name, "console-app-ops");
    assert!(
        cfg.ops_cockpit
            .as_ref()
            .and_then(|o| o.records_dir.as_ref())
            .is_some()
    );

    // Valid bundle passes console_ops_config_check (positional and --dir).
    let bin = env!("CARGO_BIN_EXE_console_ops_config_check");
    assert!(Command::new(bin).arg(&dir).output()?.status.success());
    assert!(
        Command::new(bin)
            .args(["--dir", &dir.display().to_string()])
            .output()?
            .status
            .success()
    );

    // Planted invalid configs exit 78 naming file + JSON pointer.
    let bad_dir = temp_bundle()?;
    std::fs::write(
        bad_dir.join("operators.json"),
        json!([{
            "person": "00000000-0000-4000-8000-000000000001",
            "email_sha256": "operator@example.invalid",
            "grants": []
        }])
        .to_string(),
    )?;
    let check_out = Command::new(bin).arg(&bad_dir).output()?;
    assert_eq!(check_out.status.code(), Some(78));
    let stderr = String::from_utf8_lossy(&check_out.stderr);
    assert!(
        stderr.contains("OPS_CONFIG_INVALID") && stderr.contains("operators.json#/0/email_sha256"),
        "{stderr}"
    );

    let app_out = Command::new(env!("CARGO_BIN_EXE_console-app"))
        .env("CONSOLE_APP_ROLE", "ops")
        .env("CONSOLE_OPS_CONFIG_DIR", &bad_dir)
        .output()?;
    assert_eq!(app_out.status.code(), Some(78));

    // Userinfo / query / fragment in source URL exits 78 in both CLI and console-app.
    let uri_dir = temp_bundle()?;
    let settings_raw = std::fs::read_to_string(uri_dir.join("ops-settings.json"))?;
    let mut settings_json: serde_json::Value = serde_json::from_str(&settings_raw)?;
    settings_json["sources"]["alertmanager"]["url"] = json!("http://user:pass@example.invalid");
    std::fs::write(uri_dir.join("ops-settings.json"), settings_json.to_string())?;
    assert_eq!(
        Command::new(bin).arg(&uri_dir).output()?.status.code(),
        Some(78)
    );
    assert_eq!(
        Command::new(env!("CARGO_BIN_EXE_console-app"))
            .env("CONSOLE_APP_ROLE", "ops")
            .env("CONSOLE_OPS_CONFIG_DIR", &uri_dir)
            .output()?
            .status
            .code(),
        Some(78)
    );
    let _ = std::fs::remove_dir_all(uri_dir);

    let _ = std::fs::remove_dir_all(dir);
    let _ = std::fs::remove_dir_all(bad_dir);
    Ok(())
}

#[tokio::test]
async fn cross_realm_routes_stay_404_and_metrics_start_at_zero() -> TestResult {
    let dir = temp_bundle()?;
    let dist = std::env::temp_dir().join(format!("ops-dist-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dist)?;
    std::fs::write(dist.join("index.html"), "<!doctype html><title>ops</title>")?;

    let handle = install_metrics_recorder()?;
    init_ops_metrics();

    let cfg = AppConfig::from_pairs([
        ("CONSOLE_APP_ROLE", "ops".to_owned()),
        ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
        ("CONSOLE_OPS_CONFIG_DIR", dir.display().to_string()),
        ("CONSOLE_WEB_DIST", dist.display().to_string()),
    ])?;
    let ops_cfg = cfg.ops_cockpit.clone().ok_or("ops_cockpit")?;
    let now = OffsetDateTime::now_utc();
    let jwt = Arc::new(AccessJwtVerifier::new(&ops_cfg.settings.access)?);
    jwt.refresh(now).await?;
    metrics::gauge!("ops_cockpit_access_jwks_age_seconds").set(jwt.jwks_age_seconds(now) as f64);
    let registry = Arc::new(OperatorRegistry::from_json(&ops_cfg.operators_json)?);
    let eval = CockpitEvaluator::new(
        SourcePorts {
            alertmanager: Arc::new(StubSources),
            vmalert: Arc::new(StubSources),
            victoriametrics: Arc::new(StubSources),
        },
        ops_cfg.components.clone(),
        ops_cfg.settings.clone(),
        now,
    );
    let (_, rx) = watch::channel(false);
    let ops_state = OpsRestState::new(
        registry,
        jwt,
        eval.evaluate(now),
        ops_cfg.settings.origin.clone(),
        rx,
    );
    let ops_app = build_ops_router(
        &cfg,
        ops_state,
        Arc::new(AtomicBool::new(true)),
        Arc::new(AtomicBool::new(false)),
    );

    // Ops router refuses all tenant/platform routes with JSON 404 (never index.html).
    for foreign in ["/api/v1/employees", "/api/platform/orgs", "/api/audit"] {
        let resp = ops_app
            .clone()
            .oneshot(Request::get(foreign).body(Body::empty())?)
            .await?;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND, "{foreign}");
        let body = String::from_utf8(to_bytes(resp.into_body(), 65536).await?.to_vec())?;
        assert!(!body.contains("<!doctype html>"), "{foreign}");
        let json: serde_json::Value = serde_json::from_str(&body)?;
        assert_eq!(json["code"], "not_found");
    }

    // Ops router enforces origin_guard across unmatched /api/* and SPA fallback routes.
    for path in ["/api/ops/v1/nonexistent", "/healthz", "/unknown-spa"] {
        let resp = ops_app
            .clone()
            .oneshot(Request::post(path).body(Body::empty())?)
            .await?;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN, "POST {path}");
        let body = String::from_utf8(to_bytes(resp.into_body(), 65536).await?.to_vec())?;
        let json: serde_json::Value = serde_json::from_str(&body)?;
        assert_eq!(json["code"], "origin_refused", "POST {path}");
    }

    // Tenant API router refuses all /api/ops/v1/* routes with 404.
    let api_cfg = AppConfig::from_pairs([
        ("CONSOLE_APP_ROLE", "api"),
        ("CONSOLE_HTTP_ADDR", "127.0.0.1:0"),
    ])?;
    let api_app = build_router(AppState::new(api_cfg, DatabaseDependency::NotConfigured)?);
    for ops_path in ["/api/ops/v1/home", "/api/ops/v1/me", "/api/ops/v1/events"] {
        let resp = api_app
            .clone()
            .oneshot(Request::get(ops_path).body(Body::empty())?)
            .await?;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND, "{ops_path}");
    }

    let metrics_text = handle.render();
    for series in [
        "ops_cockpit_evaluator_last_success_timestamp_seconds",
        "ops_cockpit_source_reads_total",
        "ops_cockpit_source_age_seconds",
        "ops_cockpit_access_jwks_age_seconds",
        "ops_cockpit_record_writes_total",
        "ops_cockpit_record_verifications_total",
        "ops_cockpit_sse_clients",
        "ops_cockpit_sse_events_total",
        "ops_cockpit_sse_resyncs_total",
        "ops_cockpit_authz_decisions_total",
    ] {
        assert!(metrics_text.contains(series), "missing metric {series}");
    }

    let _ = Path::new(&dir);
    let _ = std::fs::remove_dir_all(dir);
    let _ = std::fs::remove_dir_all(dist);
    let _ = BTreeMap::<String, String>::new();
    Ok(())
}
