// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::BTreeMap;
use std::num::NonZeroU64;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::bundle::{as_object, check_exact_keys, check_pos_int, err, is_valid_http_uri};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadLimitsSettings {
    pub request_timeout_ms: NonZeroU64,
    pub max_response_bytes: NonZeroU64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceEndpointSettings {
    pub url: String,
    pub producer: String,
    pub interval_s: NonZeroU64,
    pub read_limits: ReadLimitsSettings,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceSettings {
    pub alertmanager: SourceEndpointSettings,
    pub vmalert: SourceEndpointSettings,
    pub victoriametrics: SourceEndpointSettings,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccessSettings {
    pub team: String,
    pub aud: String,
    pub issuer: String,
    pub jwks: String,
    pub interval_s: NonZeroU64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordsSettings {
    pub dir: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObligationsSettings {
    pub due_soon_days: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpsSettings {
    pub sources: SourceSettings,
    pub access: AccessSettings,
    pub origin: String,
    pub thresholds: BTreeMap<String, f64>,
    pub budgets: BTreeMap<String, NonZeroU64>,
    #[serde(default)]
    pub records: Option<RecordsSettings>,
    #[serde(default)]
    pub obligations: Option<ObligationsSettings>,
}

impl OpsSettings {
    pub fn due_soon_days(&self) -> u32 {
        self.obligations.as_ref().map_or(7, |o| o.due_soon_days)
    }
}

fn check_non_banned_text<'a>(
    value: &'a Value,
    pointer: &str,
) -> Result<&'a str, crate::bundle::ConfigViolation> {
    crate::bundle::check_non_banned_text(value, pointer)
}

fn validate_source_endpoint(
    value: &Value,
    pointer: &str,
) -> Result<(), crate::bundle::ConfigViolation> {
    let obj = as_object(value, pointer)?;
    check_exact_keys(
        obj,
        pointer,
        &["url", "producer", "interval_s", "read_limits"],
    )?;
    let url = obj["url"]
        .as_str()
        .ok_or_else(|| err(format!("{pointer}/url"), "expected a string"))?;
    if !is_valid_http_uri(url) {
        return Err(err(format!("{pointer}/url"), "expected http or https URI"));
    }
    check_non_banned_text(&obj["producer"], &format!("{pointer}/producer"))?;
    let interval_s = check_pos_int(&obj["interval_s"], &format!("{pointer}/interval_s"))?;
    let limits_ptr = format!("{pointer}/read_limits");
    let limits = as_object(&obj["read_limits"], &limits_ptr)?;
    check_exact_keys(
        limits,
        &limits_ptr,
        &["request_timeout_ms", "max_response_bytes"],
    )?;
    let timeout_ms = check_pos_int(
        &limits["request_timeout_ms"],
        &format!("{limits_ptr}/request_timeout_ms"),
    )?;
    check_pos_int(
        &limits["max_response_bytes"],
        &format!("{limits_ptr}/max_response_bytes"),
    )?;
    if u128::from(timeout_ms) >= u128::from(interval_s) * 1000 {
        return Err(err(
            format!("{limits_ptr}/request_timeout_ms"),
            "request_timeout_ms must be strictly less than interval_s * 1000",
        ));
    }
    Ok(())
}

fn validate_optional_sections(
    root: &Map<String, Value>,
) -> Result<(), crate::bundle::ConfigViolation> {
    if let Some(records_val) = root.get("records") {
        let records = as_object(records_val, "/records")?;
        check_exact_keys(records, "/records", &["dir"])?;
        let dir = check_non_banned_text(&records["dir"], "/records/dir")?;
        if !dir.starts_with('/') || dir.starts_with("//") || dir.chars().any(char::is_control) {
            return Err(err(
                "/records/dir",
                "expected non-empty absolute path without control characters",
            ));
        }
    }
    if let Some(obligations_val) = root.get("obligations") {
        let obligations = as_object(obligations_val, "/obligations")?;
        check_exact_keys(obligations, "/obligations", &["due_soon_days"])?;
        let days = check_pos_int(&obligations["due_soon_days"], "/obligations/due_soon_days")?;
        if u32::try_from(days).is_err() {
            return Err(err(
                "/obligations/due_soon_days",
                "integer out of u32 range",
            ));
        }
    }
    Ok(())
}

pub fn validate_ops_settings_json(
    raw: &str,
) -> Result<OpsSettings, crate::bundle::ConfigViolation> {
    let value: Value =
        serde_json::from_str(raw).map_err(|e| err("", format!("invalid JSON: {e}")))?;
    let root = as_object(&value, "")?;
    let required = ["sources", "access", "origin", "thresholds", "budgets"];
    for key in required {
        if !root.contains_key(key) {
            return Err(err(format!("/{key}"), "missing required field"));
        }
    }
    for key in root.keys() {
        if !required.contains(&key.as_str()) && !matches!(key.as_str(), "records" | "obligations") {
            return Err(err(format!("/{key}"), "unknown field"));
        }
    }
    let sources = as_object(&root["sources"], "/sources")?;
    check_exact_keys(
        sources,
        "/sources",
        &["alertmanager", "vmalert", "victoriametrics"],
    )?;
    for name in ["alertmanager", "vmalert", "victoriametrics"] {
        validate_source_endpoint(&sources[name], &format!("/sources/{name}"))?;
    }
    let access = as_object(&root["access"], "/access")?;
    check_exact_keys(
        access,
        "/access",
        &["team", "aud", "issuer", "jwks", "interval_s"],
    )?;
    check_non_banned_text(&access["team"], "/access/team")?;
    check_non_banned_text(&access["aud"], "/access/aud")?;
    let issuer = access["issuer"]
        .as_str()
        .ok_or_else(|| err("/access/issuer", "expected a string"))?;
    if !is_valid_http_uri(issuer) {
        return Err(err("/access/issuer", "expected http or https URI"));
    }
    let jwks = access["jwks"]
        .as_str()
        .ok_or_else(|| err("/access/jwks", "expected a string"))?;
    if !((jwks.starts_with('/') && !jwks.starts_with("//")) || is_valid_http_uri(jwks)) {
        return Err(err(
            "/access/jwks",
            "expected absolute file path or http/https URI",
        ));
    }
    check_pos_int(&access["interval_s"], "/access/interval_s")?;
    let origin = root["origin"]
        .as_str()
        .ok_or_else(|| err("/origin", "expected a string"))?;
    let origin_rest = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))
        .unwrap_or("");
    if origin_rest.is_empty()
        || origin_rest.contains(['/', '?', '#'])
        || origin.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(err(
            "/origin",
            "origin must match ^https?://[^/?#]+$ without trailing path",
        ));
    }
    for (key, val) in as_object(&root["thresholds"], "/thresholds")? {
        if !val.as_f64().is_some_and(f64::is_finite) {
            return Err(err(
                format!("/thresholds/{key}"),
                "expected a finite number",
            ));
        }
    }
    for (key, val) in as_object(&root["budgets"], "/budgets")? {
        check_pos_int(val, &format!("/budgets/{key}"))?;
    }
    validate_optional_sections(root)?;
    serde_json::from_value(value).map_err(|e| err("", format!("invalid ops settings: {e}")))
}
