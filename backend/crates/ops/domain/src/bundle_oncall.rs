// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::BTreeSet;
use std::num::NonZeroU64;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::{Duration, OffsetDateTime, Time, UtcOffset};

use crate::bundle::{
    ConfigViolation, as_object, check_exact_keys, check_non_banned_text, check_pos_int, err,
};

pub const SHIFT_BOUND_ACTIONS: &[&str] = &["alert.ack", "alert.silence", "incident.write"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveOncallShift {
    pub active_person: Option<String>,
    pub backup_person: Option<String>,
    pub shift_from: OffsetDateTime,
    pub shift_until: OffsetDateTime,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OncallMode {
    SingleOperator,
    PrimaryBackup,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Weekday {
    Mon,
    Tue,
    Wed,
    Thu,
    Fri,
    Sat,
    Sun,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OncallRotation {
    pub primary_person: Option<String>,
    pub backup_person: Option<String>,
    pub handoff_weekday: Weekday,
    pub handoff_hour_local: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OncallEscalation {
    pub ack_timeout_s: u64,
    pub repeat_interval_s: u64,
    pub out_of_hours_policy: String,
    pub daily_page_budget: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SyntheticPageTest {
    pub enabled: bool,
    pub schedule: String,
    pub weekday: Weekday,
    pub hour_utc: u8,
    pub max_delivery_lag_s: NonZeroU64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OncallConfig {
    pub version: u32,
    pub mode: OncallMode,
    pub display_status: String,
    pub timezone: String,
    pub rotation: OncallRotation,
    pub escalation: OncallEscalation,
    pub synthetic_page_test: SyntheticPageTest,
}

impl Weekday {
    fn iso_monday_zero(self) -> i64 {
        match self {
            Self::Mon => 0,
            Self::Tue => 1,
            Self::Wed => 2,
            Self::Thu => 3,
            Self::Fri => 4,
            Self::Sat => 5,
            Self::Sun => 6,
        }
    }
}

fn tz_offset(name: &str) -> UtcOffset {
    match name.trim() {
        "Asia/Seoul" | "ROK" => UtcOffset::from_hms(9, 0, 0).unwrap_or(UtcOffset::UTC),
        "Asia/Tokyo" => UtcOffset::from_hms(9, 0, 0).unwrap_or(UtcOffset::UTC),
        _ => UtcOffset::UTC,
    }
}

impl OncallConfig {
    pub fn active_shift(&self, now: OffsetDateTime) -> ActiveOncallShift {
        let offset = tz_offset(&self.timezone);
        let local_now = now.to_offset(offset);
        let cur_wd = i64::from(local_now.weekday().number_days_from_monday());
        let target_wd = self.rotation.handoff_weekday.iso_monday_zero();
        let mut days_back = (cur_wd - target_wd).rem_euclid(7);
        let handoff_time = Time::from_hms(self.rotation.handoff_hour_local.min(23), 0, 0)
            .unwrap_or(Time::MIDNIGHT);
        if days_back == 0 && local_now.time() < handoff_time {
            days_back = 7;
        }
        let handoff_date = local_now.date() - Duration::days(days_back);
        let shift_from = handoff_date
            .with_time(handoff_time)
            .assume_offset(offset)
            .to_offset(UtcOffset::UTC);
        let shift_until = shift_from + Duration::days(7);

        let (active_person, backup_person) = match self.mode {
            OncallMode::SingleOperator => (self.rotation.primary_person.clone(), None),
            OncallMode::PrimaryBackup => {
                let week_idx = shift_from.unix_timestamp().div_euclid(7 * 86_400);
                if week_idx.rem_euclid(2) == 1 && self.rotation.backup_person.is_some() {
                    (
                        self.rotation.backup_person.clone(),
                        self.rotation.primary_person.clone(),
                    )
                } else {
                    (
                        self.rotation.primary_person.clone(),
                        self.rotation.backup_person.clone(),
                    )
                }
            }
        };

        ActiveOncallShift {
            active_person,
            backup_person,
            shift_from,
            shift_until,
        }
    }
}

fn is_uuid_v_hex(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (idx, &b) in bytes.iter().enumerate() {
        if matches!(idx, 8 | 13 | 18 | 23) {
            if b != b'-' {
                return false;
            }
        } else if !b.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

fn check_int_range(
    value: &Value,
    pointer: &str,
    min: u64,
    max: u64,
) -> Result<u64, ConfigViolation> {
    let n = value
        .as_u64()
        .ok_or_else(|| err(pointer, format!("expected integer in {min}..={max}")))?;
    if n < min || n > max {
        return Err(err(pointer, format!("expected integer in {min}..={max}")));
    }
    Ok(n)
}

fn check_person_field(
    value: &Value,
    pointer: &str,
    known: Option<&BTreeSet<&str>>,
) -> Result<(), ConfigViolation> {
    match value {
        Value::Null => Ok(()),
        Value::String(id) => {
            if !is_uuid_v_hex(id) {
                return Err(err(pointer, "expected null or operator UUID"));
            }
            if let Some(set) = known
                && !set.contains(id.as_str())
            {
                return Err(err(
                    pointer,
                    "operator UUID not registered in operators.json",
                ));
            }
            Ok(())
        }
        _ => Err(err(pointer, "expected null or operator UUID")),
    }
}

pub fn validate_oncall_json(
    raw: &str,
    known_operator_persons: Option<&[&str]>,
) -> Result<OncallConfig, ConfigViolation> {
    if raw.contains('@') {
        return Err(err("", "plaintext email character '@' forbidden"));
    }
    let value: Value =
        serde_json::from_str(raw).map_err(|e| err("", format!("invalid JSON: {e}")))?;
    let root = as_object(&value, "")?;
    check_exact_keys(
        root,
        "",
        &[
            "version",
            "mode",
            "display_status",
            "timezone",
            "rotation",
            "escalation",
            "synthetic_page_test",
        ],
    )?;
    if root["version"].as_u64() != Some(1) {
        return Err(err("/version", "expected version 1"));
    }
    let mode = root["mode"]
        .as_str()
        .ok_or_else(|| err("/mode", "expected single-operator or primary-backup"))?;
    if !matches!(mode, "single-operator" | "primary-backup") {
        return Err(err("/mode", "expected single-operator or primary-backup"));
    }
    let display_status = check_non_banned_text(&root["display_status"], "/display_status")?;
    check_non_banned_text(&root["timezone"], "/timezone")?;
    if mode == "single-operator" && display_status != "Single operator on call" {
        return Err(err(
            "/display_status",
            "single-operator mode requires 'Single operator on call'",
        ));
    }

    let known_set =
        known_operator_persons.map(|list| list.iter().copied().collect::<BTreeSet<_>>());
    let rot = as_object(&root["rotation"], "/rotation")?;
    check_exact_keys(
        rot,
        "/rotation",
        &[
            "primary_person",
            "backup_person",
            "handoff_weekday",
            "handoff_hour_local",
        ],
    )?;
    check_person_field(
        &rot["primary_person"],
        "/rotation/primary_person",
        known_set.as_ref(),
    )?;
    check_person_field(
        &rot["backup_person"],
        "/rotation/backup_person",
        known_set.as_ref(),
    )?;
    if mode == "single-operator" && !rot["backup_person"].is_null() {
        return Err(err(
            "/rotation/backup_person",
            "single-operator mode forbids backup_person",
        ));
    }
    let weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    if !rot["handoff_weekday"]
        .as_str()
        .is_some_and(|w| weekdays.contains(&w))
    {
        return Err(err(
            "/rotation/handoff_weekday",
            "expected weekday Mon..Sun",
        ));
    }
    check_int_range(
        &rot["handoff_hour_local"],
        "/rotation/handoff_hour_local",
        0,
        23,
    )?;

    let esc = as_object(&root["escalation"], "/escalation")?;
    check_exact_keys(
        esc,
        "/escalation",
        &[
            "ack_timeout_s",
            "repeat_interval_s",
            "out_of_hours_policy",
            "daily_page_budget",
        ],
    )?;
    if esc["ack_timeout_s"].as_u64().is_none_or(|v| v < 60) {
        return Err(err("/escalation/ack_timeout_s", "expected integer >= 60"));
    }
    if esc["repeat_interval_s"].as_u64().is_none_or(|v| v < 300) {
        return Err(err(
            "/escalation/repeat_interval_s",
            "expected integer >= 300",
        ));
    }
    if esc["out_of_hours_policy"].as_str() != Some("sev1-symptoms-only") {
        return Err(err(
            "/escalation/out_of_hours_policy",
            "expected sev1-symptoms-only",
        ));
    }
    check_int_range(
        &esc["daily_page_budget"],
        "/escalation/daily_page_budget",
        1,
        2,
    )?;

    let spt = as_object(&root["synthetic_page_test"], "/synthetic_page_test")?;
    check_exact_keys(
        spt,
        "/synthetic_page_test",
        &[
            "enabled",
            "schedule",
            "weekday",
            "hour_utc",
            "max_delivery_lag_s",
        ],
    )?;
    if !spt["enabled"].is_boolean() {
        return Err(err("/synthetic_page_test/enabled", "expected boolean"));
    }
    if spt["schedule"].as_str() != Some("weekly") {
        return Err(err("/synthetic_page_test/schedule", "expected weekly"));
    }
    if !spt["weekday"]
        .as_str()
        .is_some_and(|w| weekdays.contains(&w))
    {
        return Err(err(
            "/synthetic_page_test/weekday",
            "expected weekday Mon..Sun",
        ));
    }
    check_int_range(&spt["hour_utc"], "/synthetic_page_test/hour_utc", 0, 23)?;
    check_pos_int(
        &spt["max_delivery_lag_s"],
        "/synthetic_page_test/max_delivery_lag_s",
    )?;

    serde_json::from_value(value).map_err(|e| err("", format!("invalid oncall config: {e}")))
}
