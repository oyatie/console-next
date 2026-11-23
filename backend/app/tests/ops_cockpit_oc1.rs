// SPDX-License-Identifier: LicenseRef-Proprietary
use std::path::PathBuf;
use std::process::Command;

use console_app::{AppConfig, AppRole};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::Generate;
use p256::pkcs8::{EncodePrivateKey, LineEnding};
use serde_json::json;

type TestResult = Result<(), Box<dyn std::error::Error>>;

struct CleanupDir(PathBuf);
impl Drop for CleanupDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn temp_bundle_oc1() -> Result<CleanupDir, Box<dyn std::error::Error>> {
    let dir = std::env::temp_dir().join(format!("ops-oc1-bundle-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join("runbooks"))?;
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
    std::fs::write(
        dir.join("ops-settings.json"),
        json!({
            "sources": {"alertmanager": src, "vmalert": src, "victoriametrics": src},
            "access": {"team": "cosskorea", "aud": "ops-aud", "issuer": "https://cosskorea.cloudflareaccess.com", "jwks": jwks_path.display().to_string(), "interval_s": 3600},
            "origin": "https://ops.cosskorea.com",
            "thresholds": {"source_stale_multiplier": 2, "jwks_max_age_s": 3024000},
            "budgets": {"evaluate_interval_s": 15, "record_spool_max_files": 10000}
        })
        .to_string(),
    )?;
    std::fs::write(
        dir.join("operators.json"),
        json!([{
            "person": "00000000-0000-4000-8000-000000000001",
            "email_sha256": "a".repeat(64),
            "grants": [{"action": "read.home", "from": "2026-01-01T00:00:00Z", "until": "2027-01-01T00:00:00Z"}]
        }])
        .to_string(),
    )?;
    std::fs::write(
        dir.join("oncall.json"),
        json!({
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
    )?;
    std::fs::write(
        dir.join("runbooks/RUNBOOK.md"),
        "# Ops Runbook\nCheck service.\n",
    )?;
    Ok(CleanupDir(dir))
}

#[test]
fn ops_role_parses_oc1_env_vars_and_validates_oncall_and_runbooks() -> TestResult {
    let bundle = temp_bundle_oc1()?;
    let cfg = AppConfig::from_pairs([
        ("CONSOLE_APP_ROLE", "ops".to_owned()),
        ("CONSOLE_OPS_CONFIG_DIR", bundle.0.display().to_string()),
        (
            "CONSOLE_OPS_RECORDS_DIR",
            "/srv/console/ops-records".to_owned(),
        ),
        (
            "CONSOLE_OPS_RELEASES_DIR",
            "/srv/console/releases".to_owned(),
        ),
        ("CONSOLE_OPS_STATE_DIR", "/srv/console/state".to_owned()),
        (
            "CONSOLE_OPS_STATUS_URL",
            "https://status.example.invalid/status.v2.json".to_owned(),
        ),
    ])?;
    assert_eq!(cfg.role, AppRole::Ops);
    let ops = cfg.ops_cockpit.as_ref().ok_or("ops_cockpit missing")?;
    assert_eq!(
        ops.releases_dir.as_deref(),
        Some(std::path::Path::new("/srv/console/releases"))
    );
    assert_eq!(
        ops.state_dir.as_deref(),
        Some(std::path::Path::new("/srv/console/state"))
    );
    assert_eq!(
        ops.status_url.as_deref(),
        Some("https://status.example.invalid/status.v2.json")
    );
    assert!(ops.oncall.is_some());

    let bin = env!("CARGO_BIN_EXE_console_ops_config_check");
    assert!(Command::new(bin).arg(&bundle.0).output()?.status.success());

    // Unknown primary_person UUID in oncall.json -> exit 78
    let bad_oncall = temp_bundle_oc1()?;
    let raw = std::fs::read_to_string(bad_oncall.0.join("oncall.json"))?;
    std::fs::write(
        bad_oncall.0.join("oncall.json"),
        raw.replace(
            "00000000-0000-4000-8000-000000000001",
            "00000000-0000-4000-8000-000000000099",
        ),
    )?;
    let out = Command::new(bin).arg(&bad_oncall.0).output()?;
    assert_eq!(out.status.code(), Some(78));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("OPS_CONFIG_INVALID") && stderr.contains("oncall.json"),
        "{stderr}"
    );

    // Missing RUNBOOK.md when runbooks/ exists -> exit 78
    let bad_rb = temp_bundle_oc1()?;
    std::fs::remove_file(bad_rb.0.join("runbooks/RUNBOOK.md"))?;
    let out_rb = Command::new(bin).arg(&bad_rb.0).output()?;
    assert_eq!(out_rb.status.code(), Some(78));
    let stderr_rb = String::from_utf8_lossy(&out_rb.stderr);
    assert!(
        stderr_rb.contains("OPS_CONFIG_INVALID") && stderr_rb.contains("runbooks"),
        "{stderr_rb}"
    );
    Ok(())
}
