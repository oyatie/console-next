// SPDX-License-Identifier: LicenseRef-Proprietary
use std::num::NonZeroU64;

use console_ops_domain::bundle::validate_ops_settings_json;
use console_ops_domain::{ObservedTimestamp, UtcTimestamp};
use serde_json::json;
use time::OffsetDateTime;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[test]
fn observed_timestamp_serializes_value_as_rfc3339_utc_z_string() -> TestResult {
    let local = OffsetDateTime::parse(
        "2026-11-21T19:27:31.57662+09:00",
        &time::format_description::well_known::Rfc3339,
    )?;
    let observed = ObservedTimestamp::current(
        UtcTimestamp::new(local),
        None,
        "fixture".into(),
        local,
        local,
        NonZeroU64::new(60).ok_or("non-zero interval")?,
    );
    let body = serde_json::to_value(observed)?;
    assert_eq!(body["state"], "Verified");
    let value_str = body["value"].as_str().ok_or("value must be JSON string")?;
    assert!(value_str.ends_with('Z'), "must end with Z: {value_str}");
    assert_eq!(value_str, "2026-11-21T10:27:31.57662Z");
    assert_eq!(body["observed_at"], "2026-11-21T10:27:31.57662Z");

    let unknown = ObservedTimestamp::unknown("fixture".into(), "not instrumented".into());
    let unknown_body = serde_json::to_value(unknown)?;
    assert!(unknown_body["value"].is_null());
    Ok(())
}

#[test]
fn bundle_rejects_userinfo_query_and_fragment_in_http_uris() -> TestResult {
    for bad in [
        "http://user:pass@alertmanager:9093",
        "http://user@alertmanager:9093",
        "http://alertmanager:9093?x=1",
        "http://alertmanager:9093#frag",
        "https://:9093",
    ] {
        let src = json!({
            "url": bad,
            "producer": "fixture",
            "interval_s": 15,
            "read_limits": {"request_timeout_ms": 5000, "max_response_bytes": 4096}
        });
        let raw = json!({
            "sources": {
                "alertmanager": src,
                "vmalert": {
                    "url": "http://vmalert:8880",
                    "producer": "fixture",
                    "interval_s": 15,
                    "read_limits": {"request_timeout_ms": 5000, "max_response_bytes": 4096}
                },
                "victoriametrics": {
                    "url": "http://victoriametrics:8428",
                    "producer": "fixture",
                    "interval_s": 15,
                    "read_limits": {"request_timeout_ms": 5000, "max_response_bytes": 4096}
                }
            },
            "access": {
                "team": "cosskorea",
                "aud": "ops-aud",
                "issuer": "https://example.cloudflareaccess.com",
                "jwks": "/etc/console/ops/access-jwks.json",
                "interval_s": 3600
            },
            "origin": "https://ops.cosskorea.com",
            "thresholds": {},
            "budgets": {}
        })
        .to_string();
        let err = match validate_ops_settings_json(&raw) {
            Ok(_) => return Err(format!("expected {bad} to fail validation").into()),
            Err(err) => err,
        };
        assert_eq!(err.pointer, "/sources/alertmanager/url", "{bad}: {err}");
    }
    Ok(())
}
