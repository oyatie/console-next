// SPDX-License-Identifier: LicenseRef-Proprietary
//! Weekly monitor policy; legal limits come from the dated register.
use serde::{Deserialize, Serialize};

use crate::Week52Input;
use time::{Date, OffsetDateTime};
use uuid::Uuid;

pub const WARN_HOURS_KEY: console_settings_domain::SettingKey =
    console_settings_domain::SettingKey::AttendanceWeek52WarnHours;

#[derive(Debug, Clone, Copy)]
pub struct Week52Limits {
    pub danger_hours: f64,
    pub warn_hours: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Week52Tone {
    Ok,
    Warn,
    Danger,
    Unknown,
}

pub fn week52_tone(input: &Week52Input, limits: Week52Limits) -> Week52Tone {
    if input.current_hours >= limits.danger_hours || input.projected_hours >= limits.danger_hours {
        Week52Tone::Danger
    } else {
        match limits.warn_hours {
            Some(warn) if input.projected_hours >= warn => Week52Tone::Warn,
            Some(_) => Week52Tone::Ok,
            None => Week52Tone::Unknown,
        }
    }
}

/// Weekly compliance counts scheduled work plus approved, actually worked excess.
/// Paid time outside the schedule remains separate until its approval is stored.
pub fn approved_day_hours(
    recognition: &console_attendance_domain::records::Recognition,
    approved_hours: Option<f64>,
) -> Option<(f64, f64)> {
    let approved = approved_hours?;
    if !approved.is_finite() || approved < 0.0 {
        return None;
    }
    let overtime = approved.min(f64::from(recognition.outside_scheduled) / 60.0);
    Some((f64::from(recognition.regular) / 60.0 + overtime, overtime))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Week52Read {
    pub employee_id: Uuid,
    pub name: String,
    pub team: Option<String>,
    pub week_start: Date,
    pub current_hours: f64,
    pub projected_hours: f64,
    pub recognized_hours: Option<f64>,
    pub overtime_hours: Option<f64>,
    pub tone: Week52Tone,
    pub acknowledged_at: Option<OffsetDateTime>,
}
