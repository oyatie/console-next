// SPDX-License-Identifier: LicenseRef-Proprietary
use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};

use crate::UtcTimestamp;
use crate::ladders::Severity;

pub const PAGE_MAX_SILENCE_TTL_S: i64 = 4 * 3600;
pub const TICKET_MAX_SILENCE_TTL_S: i64 = 72 * 3600;

fn default_is_equal() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AlertAckPayload {
    #[serde(default)]
    pub note: Option<String>,
}

pub fn validate_alert_ack_note(note: Option<&str>) -> Result<Option<String>, &'static str> {
    let Some(raw) = note else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().any(char::is_control) || matches!(trimmed, "No data" | "N/A" | "—") {
        return Err("OPS_ALERT_ACK_INVALID");
    }
    Ok(Some(trimmed.to_owned()))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SilenceMatcherInput {
    pub name: String,
    pub value: String,
    #[serde(default)]
    pub is_regex: bool,
    #[serde(default = "default_is_equal")]
    pub is_equal: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SilenceCreateInput {
    pub matchers: Vec<SilenceMatcherInput>,
    pub ends_at: String,
    pub comment: String,
    #[serde(default)]
    pub group_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ValidatedSilenceCreate {
    pub matchers: Vec<SilenceMatcherInput>,
    pub starts_at: UtcTimestamp,
    pub ends_at: UtcTimestamp,
    pub comment: String,
    pub group_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SilenceValidationError {
    Invalid(String),
    TtlExceeded(String),
    WatchdogUnsilenceable,
}

impl SilenceValidationError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Invalid(_) => "OPS_SILENCE_INVALID",
            Self::TtlExceeded(_) => "OPS_SILENCE_TTL_EXCEEDED",
            Self::WatchdogUnsilenceable => "OPS_WATCHDOG_UNSILENCEABLE",
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::Invalid(msg) | Self::TtlExceeded(msg) => msg,
            Self::WatchdogUnsilenceable => "Watchdog alert is unsilenceable",
        }
    }
}

pub fn validate_silence_create(
    input: &SilenceCreateInput,
    target_severity: Option<Severity>,
    now: OffsetDateTime,
) -> Result<ValidatedSilenceCreate, SilenceValidationError> {
    if input.matchers.is_empty() {
        return Err(SilenceValidationError::Invalid(
            "at least one exact matcher is required".to_owned(),
        ));
    }

    let mut normalized_matchers = Vec::with_capacity(input.matchers.len());
    let mut has_non_watchdog_alertname = false;

    for m in &input.matchers {
        if m.is_regex || !m.is_equal {
            return Err(SilenceValidationError::Invalid(
                "only exact '=' matchers are allowed".to_owned(),
            ));
        }
        let name = m.name.trim();
        let value = m.value.trim();
        if name.is_empty()
            || value.is_empty()
            || name.chars().any(char::is_control)
            || value.chars().any(char::is_control)
        {
            return Err(SilenceValidationError::Invalid(
                "matcher name and value must be non-empty without control characters".to_owned(),
            ));
        }
        if name.eq_ignore_ascii_case("alertname") {
            if value.eq_ignore_ascii_case("watchdog") {
                return Err(SilenceValidationError::WatchdogUnsilenceable);
            }
            has_non_watchdog_alertname = true;
        }
        normalized_matchers.push(SilenceMatcherInput {
            name: name.to_owned(),
            value: value.to_owned(),
            is_regex: false,
            is_equal: true,
        });
    }

    if !has_non_watchdog_alertname {
        return Err(SilenceValidationError::WatchdogUnsilenceable);
    }

    let comment = input.comment.trim();
    if comment.chars().count() < 10
        || comment.chars().any(char::is_control)
        || matches!(comment, "No data" | "N/A" | "—")
    {
        return Err(SilenceValidationError::Invalid(
            "comment must be at least 10 characters without control characters".to_owned(),
        ));
    }

    if !input.ends_at.ends_with('Z') {
        return Err(SilenceValidationError::Invalid(
            "ends_at must be an RFC3339 UTC timestamp ending with 'Z'".to_owned(),
        ));
    }
    let ends_at = OffsetDateTime::parse(&input.ends_at, &Rfc3339).map_err(|_| {
        SilenceValidationError::Invalid("ends_at must be a valid RFC3339 UTC timestamp".to_owned())
    })?;
    if ends_at <= now {
        return Err(SilenceValidationError::Invalid(
            "ends_at must be strictly in the future".to_owned(),
        ));
    }

    let max_ttl_s = match target_severity {
        Some(Severity::Ticket) => TICKET_MAX_SILENCE_TTL_S,
        Some(Severity::Page) | None => PAGE_MAX_SILENCE_TTL_S,
    };
    let ttl = ends_at - now;
    if ttl > Duration::seconds(max_ttl_s) {
        return Err(SilenceValidationError::TtlExceeded(format!(
            "silence duration exceeds maximum allowed {}h",
            max_ttl_s / 3600
        )));
    }

    let group_key = input
        .group_key
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);

    Ok(ValidatedSilenceCreate {
        matchers: normalized_matchers,
        starts_at: UtcTimestamp::new(now),
        ends_at: UtcTimestamp::new(ends_at),
        comment: comment.to_owned(),
        group_key,
    })
}
