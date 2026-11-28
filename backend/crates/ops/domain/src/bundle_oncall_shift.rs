// SPDX-License-Identifier: LicenseRef-Proprietary
use chrono::{DateTime, Datelike, Days, NaiveDate, TimeZone};
use chrono_tz::{GapInfo, Tz};
use time::OffsetDateTime;

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

fn handoff(zone: Tz, date: NaiveDate, hour: u8) -> Option<OffsetDateTime> {
    let local = date.and_hms_opt(u32::from(hour), 0, 0)?;
    // Use the first occurrence during a fold and the first valid instant after a gap.
    let instant = zone
        .from_local_datetime(&local)
        .earliest()
        .or_else(|| GapInfo::new(&local, &zone)?.end)?;
    OffsetDateTime::from_unix_timestamp(instant.timestamp()).ok()
}

impl OncallConfig {
    pub fn active_shift(&self, now: OffsetDateTime) -> Option<ActiveOncallShift> {
        let zone: Tz = self.timezone.trim().parse().ok()?;
        let today = DateTime::from_timestamp(now.unix_timestamp(), 0)?
            .with_timezone(&zone)
            .date_naive();
        let days_back = (i64::from(today.weekday().num_days_from_monday())
            - self.rotation.handoff_weekday.iso_monday_zero())
        .rem_euclid(7);
        let mut date = today.checked_sub_days(Days::new(days_back.try_into().ok()?))?;
        let hour = self.rotation.handoff_hour_local;
        let mut shift_from = handoff(zone, date, hour)?;
        if now < shift_from {
            date = date.checked_sub_days(Days::new(7))?;
            shift_from = handoff(zone, date, hour)?;
        }
        let shift_until = handoff(zone, date.checked_add_days(Days::new(7))?, hour)?;

        let (active_person, backup_person) = match self.mode {
            OncallMode::SingleOperator => (self.rotation.primary_person.clone(), None),
            OncallMode::PrimaryBackup => {
                let week_idx = (date - NaiveDate::default()).num_days().div_euclid(7);
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

        Some(ActiveOncallShift {
            active_person,
            backup_person,
            shift_from,
            shift_until,
        })
    }
}
