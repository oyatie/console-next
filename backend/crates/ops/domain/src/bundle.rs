// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::BTreeMap;
use std::num::NonZeroU64;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigViolation {
    pub pointer: String,
    pub message: String,
}

impl std::fmt::Display for ConfigViolation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.pointer, self.message)
    }
}

impl std::error::Error for ConfigViolation {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ComponentSpec {
    pub group: String,
    pub host: String,
    pub owner: String,
    pub dashboard: Option<String>,
    pub runbook: String,
    pub source: String,
    pub interval_s: NonZeroU64,
}

pub type ComponentsMap = BTreeMap<String, ComponentSpec>;

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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpsSettings {
    pub sources: SourceSettings,
    pub access: AccessSettings,
    pub origin: String,
    pub thresholds: BTreeMap<String, f64>,
    pub budgets: BTreeMap<String, NonZeroU64>,
}

fn err(pointer: impl Into<String>, message: impl Into<String>) -> ConfigViolation {
    ConfigViolation {
        pointer: pointer.into(),
        message: message.into(),
    }
}

fn as_object<'a>(
    value: &'a Value,
    pointer: &str,
) -> Result<&'a Map<String, Value>, ConfigViolation> {
    value
        .as_object()
        .ok_or_else(|| err(pointer, "expected a JSON object"))
}

fn check_exact_keys(
    obj: &Map<String, Value>,
    pointer: &str,
    required: &[&str],
) -> Result<(), ConfigViolation> {
    for key in required {
        if !obj.contains_key(*key) {
            return Err(err(format!("{pointer}/{key}"), "missing required field"));
        }
    }
    for key in obj.keys() {
        if !required.contains(&key.as_str()) {
            return Err(err(format!("{pointer}/{key}"), "unknown field"));
        }
    }
    Ok(())
}

fn check_non_banned_text<'a>(value: &'a Value, pointer: &str) -> Result<&'a str, ConfigViolation> {
    let text = value
        .as_str()
        .ok_or_else(|| err(pointer, "expected a string"))?;
    if text.is_empty() || matches!(text, "No data" | "N/A" | "—") {
        return Err(err(
            pointer,
            "expected non-empty text without placeholder values",
        ));
    }
    Ok(text)
}

fn check_pos_int(value: &Value, pointer: &str) -> Result<u64, ConfigViolation> {
    value
        .as_u64()
        .filter(|n| *n >= 1)
        .ok_or_else(|| err(pointer, "expected an integer >= 1"))
}

fn is_valid_http_uri(raw: &str) -> bool {
    let Some(rest) = raw
        .strip_prefix("http://")
        .or_else(|| raw.strip_prefix("https://"))
    else {
        return false;
    };
    let authority = rest.split('/').next().unwrap_or("");
    !rest.is_empty()
        && !rest.starts_with('/')
        && !rest.contains(['?', '#'])
        && !authority.is_empty()
        && !authority.starts_with(':')
        && !authority.contains('@')
        && !raw.chars().any(|c| c.is_whitespace() || c.is_control())
}

fn is_valid_component_key(key: &str) -> bool {
    let mut bytes = key.bytes();
    matches!(bytes.next(), Some(b'a'..=b'z'))
        && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

pub fn validate_components_json(raw: &str) -> Result<ComponentsMap, ConfigViolation> {
    let value: Value =
        serde_json::from_str(raw).map_err(|e| err("", format!("invalid JSON: {e}")))?;
    let root = as_object(&value, "")?;
    if root.is_empty() {
        return Err(err("", "must declare at least one component"));
    }
    let fields = [
        "group",
        "host",
        "owner",
        "dashboard",
        "runbook",
        "source",
        "interval_s",
    ];
    for (key, entry) in root {
        let ptr = format!("/{key}");
        if !is_valid_component_key(key) {
            return Err(err(&ptr, "component key must match ^[a-z][a-z0-9-]*$"));
        }
        let obj = as_object(entry, &ptr)?;
        check_exact_keys(obj, &ptr, &fields)?;
        for name in ["group", "host", "owner", "runbook", "source"] {
            check_non_banned_text(&obj[name], &format!("{ptr}/{name}"))?;
        }
        match &obj["dashboard"] {
            Value::Null => {}
            Value::String(s) if s.starts_with('/') && !s.starts_with("//") => {}
            _ => {
                return Err(err(
                    format!("{ptr}/dashboard"),
                    "expected null or root-relative path starting with single '/'",
                ));
            }
        }
        check_pos_int(&obj["interval_s"], &format!("{ptr}/interval_s"))?;
    }
    serde_json::from_value(value).map_err(|e| err("", format!("invalid components bundle: {e}")))
}

fn validate_source_endpoint(value: &Value, pointer: &str) -> Result<(), ConfigViolation> {
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

pub fn validate_ops_settings_json(raw: &str) -> Result<OpsSettings, ConfigViolation> {
    let value: Value =
        serde_json::from_str(raw).map_err(|e| err("", format!("invalid JSON: {e}")))?;
    let root = as_object(&value, "")?;
    check_exact_keys(
        root,
        "",
        &["sources", "access", "origin", "thresholds", "budgets"],
    )?;
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
    serde_json::from_value(value).map_err(|e| err("", format!("invalid ops settings: {e}")))
}
