// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::BTreeMap;
use std::num::NonZeroU64;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub use crate::bundle_oncall::{
    ActiveOncallShift, OncallConfig, OncallEscalation, OncallMode, OncallRotation,
    SHIFT_BOUND_ACTIONS, SyntheticPageTest, Weekday, validate_oncall_json,
};
pub use crate::bundle_settings::{
    AccessSettings, ObligationsSettings, OpsSettings, ReadLimitsSettings, RecordsSettings,
    SourceEndpointSettings, SourceSettings, validate_ops_settings_json,
};

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

pub(crate) fn err(pointer: impl Into<String>, message: impl Into<String>) -> ConfigViolation {
    ConfigViolation {
        pointer: pointer.into(),
        message: message.into(),
    }
}

pub(crate) fn as_object<'a>(
    value: &'a Value,
    pointer: &str,
) -> Result<&'a Map<String, Value>, ConfigViolation> {
    value
        .as_object()
        .ok_or_else(|| err(pointer, "expected a JSON object"))
}

pub(crate) fn check_exact_keys(
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

pub(crate) fn check_non_banned_text<'a>(
    value: &'a Value,
    pointer: &str,
) -> Result<&'a str, ConfigViolation> {
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

pub(crate) fn check_pos_int(value: &Value, pointer: &str) -> Result<u64, ConfigViolation> {
    value
        .as_u64()
        .filter(|n| *n >= 1)
        .ok_or_else(|| err(pointer, "expected an integer >= 1"))
}

pub(crate) fn is_valid_http_uri(raw: &str) -> bool {
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
