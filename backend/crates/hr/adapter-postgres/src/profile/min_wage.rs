//! The 최저임금 hint beside a pay input (parity E5; gate U8): the floor a wage
//! in a unit is compared with on a day, with the 고시 that sets it. Read only;
//! the figures are payroll's statutory register (`minimum_wage_on`), never a
//! number of this crate.

use console_hr_domain::profile::enums::PayUnit;
use console_hr_domain::profile::registration::{MinimumWageFloors, minimum_wage_floor};
use console_hr_domain::text::{normalize_optional_text, parse_yyyy_mm_dd};
use console_payroll_domain::minimum_wage_on;
use console_platform_authz::{Feature, Principal};
use serde::{Deserialize, Serialize};
use time::Date;

use crate::authz::hr_reach;
use crate::clock::today_kst;
use crate::{HrError, HrService};

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MinimumWageQuery {
    /// `YYYY-MM-DD`; today (KST) when omitted.
    #[serde(default)]
    pub on: Option<String>,
    pub pay_unit: String,
    #[serde(default)]
    pub weekly_minutes: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MinimumWageInstrument {
    pub name_ko: &'static str,
    pub promulgation_ko: &'static str,
    pub url: &'static str,
    pub enforced_on: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MinimumWageHint {
    pub on: String,
    pub pay_unit: PayUnit,
    pub hourly_won: i64,
    /// Null when no floor can be derived without guessing (a monthly or
    /// annual wage under 15 hours a week).
    pub floor_won: Option<i64>,
    pub instrument: MinimumWageInstrument,
}

/// `None` when the register has no 최저임금 for `on` (a year whose 고시 is not
/// recorded yet): the hint is then silent, never a guessed number.
#[must_use]
pub fn minimum_wage_hint(
    on: Date,
    pay_unit: PayUnit,
    weekly_minutes: Option<i32>,
) -> Option<MinimumWageHint> {
    let rate = minimum_wage_on(on).ok()?;
    let floors = MinimumWageFloors {
        hourly_won: rate.hourly_won,
        daily_8h_won: rate.daily_8h_won,
        monthly_209h_won: rate.monthly_209h_won,
    };
    Some(MinimumWageHint {
        on: on.to_string(),
        pay_unit,
        hourly_won: rate.hourly_won,
        floor_won: minimum_wage_floor(floors, pay_unit, weekly_minutes),
        instrument: MinimumWageInstrument {
            name_ko: rate.instrument.name_ko,
            promulgation_ko: rate.instrument.promulgation_ko,
            url: rate.instrument.url,
            enforced_on: rate.instrument.enforced_on.to_string(),
        },
    })
}

impl HrService {
    /// The registering tier reads it: the same grant that records pay.
    pub fn minimum_wage(
        &self,
        principal: &Principal,
        query: MinimumWageQuery,
    ) -> Result<Option<MinimumWageHint>, HrError> {
        hr_reach(principal, Feature::EmployeeDirectoryManage)?;
        let on = normalize_optional_text(query.on)
            .map(|raw| parse_yyyy_mm_dd(&raw))
            .transpose()?
            .unwrap_or_else(today_kst);
        let pay_unit = PayUnit::parse(&query.pay_unit)?;
        if query
            .weekly_minutes
            .is_some_and(|minutes| !(1..=10_080).contains(&minutes))
        {
            return Err(HrError::validation(
                "weekly_minutes must be between 1 and 10080",
            ));
        }
        Ok(minimum_wage_hint(on, pay_unit, query.weekly_minutes))
    }
}
