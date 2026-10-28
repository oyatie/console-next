// SPDX-License-Identifier: LicenseRef-Proprietary
//! Weekly monitor policy; legal limits come from the dated register.
use serde::{Deserialize, Serialize};

use crate::Week52Input;

pub const WARN_HOURS_KEY: console_settings_domain::SettingKey =
    console_settings_domain::SettingKey::AttendanceWeek52WarnHours;

#[derive(Debug, Clone, Copy)]
pub struct Week52Limits {
    pub danger_hours: f64,
    pub warn_hours: f64,
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
    } else if input.projected_hours >= limits.warn_hours {
        Week52Tone::Warn
    } else {
        Week52Tone::Ok
    }
}
