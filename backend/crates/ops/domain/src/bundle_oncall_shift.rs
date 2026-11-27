// SPDX-License-Identifier: LicenseRef-Proprietary
use time::{Duration, OffsetDateTime, Time, UtcOffset};

use crate::bundle_oncall::{OncallConfig, OncallMode, Weekday};

pub const SHIFT_BOUND_ACTIONS: &[&str] = &["alert.ack", "alert.silence", "incident.write"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveOncallShift {
    pub active_person: Option<String>,
    pub backup_person: Option<String>,
    pub shift_from: OffsetDateTime,
    pub shift_until: OffsetDateTime,
}

impl Weekday {
    pub(crate) fn iso_monday_zero(self) -> i64 {
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
