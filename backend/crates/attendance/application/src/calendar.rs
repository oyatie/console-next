//! 근무조 and 휴일 (ATT S1) commands and read models.

use serde::{Deserialize, Serialize};
use time::{Date, Month, OffsetDateTime};
use uuid::Uuid;

use crate::schedule::{LayerSummary, Refusal};

time::serde::format_description!(iso_date, Date, "[year]-[month]-[day]");

#[derive(Debug, Clone, Serialize)]
pub struct CrewMember {
    pub employee_id: Uuid,
    pub employee_number: Option<String>,
    pub name: String,
    #[serde(with = "iso_date")]
    pub valid_from: Date,
    #[serde(with = "iso_date::option")]
    pub valid_to: Option<Date>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CrewRead {
    pub id: Uuid,
    pub workplace_id: Uuid,
    pub workplace_name: String,
    pub name: String,
    pub status: String,
    pub members: Vec<CrewMember>,
    pub layer: Option<LayerSummary>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CrewInput {
    pub workplace_id: Uuid,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CrewMembersInput {
    pub employee_ids: Vec<Uuid>,
    #[serde(with = "iso_date")]
    pub valid_from: Date,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublicHoliday {
    #[serde(with = "iso_date")]
    pub date: Date,
    pub name: String,
    pub kind: String,
    #[serde(with = "iso_date::option")]
    pub substitute_for: Option<Date>,
    pub basis: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ContractualHoliday {
    pub id: Uuid,
    pub name: String,
    pub rule_kind: String,
    #[serde(with = "iso_date::option")]
    pub on_date: Option<Date>,
    pub month: Option<i16>,
    pub day: Option<i16>,
    pub paid: bool,
    pub scope_kind: String,
    pub scope_id: Uuid,
    pub scope_name: String,
    pub basis_kind: String,
    pub basis_ref: String,
    pub start_year: i16,
    pub end_year: Option<i16>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    pub created_by_name: String,
}

impl ContractualHoliday {
    /// The date this holiday falls on in `year`, if it is in force that year.
    #[must_use]
    pub fn date_in(&self, year: i32) -> Option<Date> {
        let in_force = i32::from(self.start_year) <= year
            && self.end_year.is_none_or(|end| year <= i32::from(end));
        if !in_force {
            return None;
        }
        match (self.on_date, self.month, self.day) {
            (Some(d), _, _) => (d.year() == year).then_some(d),
            (None, Some(m), Some(d)) => yearly_date(year, m, d),
            _ => None,
        }
    }
}

/// A yearly rule's date; a 2/29 rule has no date in a common year.
#[must_use]
pub fn yearly_date(year: i32, month: i16, day: i16) -> Option<Date> {
    let month = Month::try_from(u8::try_from(month).ok()?).ok()?;
    Date::from_calendar_date(year, month, u8::try_from(day).ok()?).ok()
}

#[derive(Debug, Clone, Serialize)]
pub struct HolidayYear {
    pub year: i32,
    pub loaded: bool,
    pub edition: Option<String>,
    pub public: Vec<PublicHoliday>,
    pub contractual: Vec<ContractualHoliday>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HolidayInput {
    pub name: String,
    #[serde(deserialize_with = "deserialize_enum_3")]
    pub rule_kind: String,
    #[serde(default, with = "iso_date::option")]
    pub on_date: Option<Date>,
    #[serde(default)]
    pub month: Option<i16>,
    #[serde(default)]
    pub day: Option<i16>,
    pub paid: bool,
    #[serde(deserialize_with = "deserialize_enum_4")]
    pub scope_kind: String,
    pub scope_id: Uuid,
    #[serde(deserialize_with = "deserialize_enum_2")]
    pub basis_kind: String,
    pub basis_ref: String,
    pub start_year: i16,
}

impl HolidayInput {
    /// The first date the holiday falls on, from its start year on.
    ///
    /// # Errors
    /// `holiday_rule_invalid` when the rule is malformed or names no date.
    pub fn first_date(&self) -> Result<Date, &'static str> {
        let year = i32::from(self.start_year);
        let invalid = "holiday_rule_invalid";
        match (self.rule_kind.as_str(), self.on_date, self.month, self.day) {
            ("DATE", Some(d), None, None) if d.year() == year => Ok(d),
            ("YEARLY", None, Some(m), Some(d)) => (year..year + 8)
                .find_map(|y| yearly_date(y, m, d))
                .ok_or(invalid),
            _ => Err(invalid),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct HolidayOverlap {
    #[serde(with = "iso_date")]
    pub date: Date,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HolidayPreview {
    pub people: i64,
    #[serde(with = "iso_date")]
    pub first_date: Date,
    pub closed_months: Vec<String>,
    pub overlaps_public: Vec<HolidayOverlap>,
    pub refusals: Vec<Refusal>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HolidayRetireInput {
    pub from_year: i16,
}

fn deserialize_enum_2<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_enum_string(
        deserializer,
        &["WORK_RULES", "COLLECTIVE_AGREEMENT"],
    )
}

fn deserialize_enum_3<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_enum_string(deserializer, &["DATE", "YEARLY"])
}

fn deserialize_enum_4<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_enum_string(
        deserializer,
        &["LEGAL_ENTITY", "WORKPLACE"],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::date;

    fn input(rule: &str, on: Option<Date>, m: Option<i16>, d: Option<i16>) -> HolidayInput {
        HolidayInput {
            name: "창립기념일".into(),
            rule_kind: rule.into(),
            on_date: on,
            month: m,
            day: d,
            paid: true,
            scope_kind: "LEGAL_ENTITY".into(),
            scope_id: Uuid::nil(),
            basis_kind: "WORK_RULES".into(),
            basis_ref: "제40조".into(),
            start_year: 2027,
        }
    }

    #[test]
    fn a_rule_names_its_first_date_or_is_refused() {
        assert_eq!(
            input("YEARLY", None, Some(3), Some(15)).first_date(),
            Ok(date!(2027 - 03 - 15))
        );
        assert_eq!(
            input("YEARLY", None, Some(2), Some(29)).first_date(),
            Ok(date!(2028 - 02 - 29))
        );
        assert_eq!(
            input("DATE", Some(date!(2027 - 05 - 03)), None, None).first_date(),
            Ok(date!(2027 - 05 - 03))
        );
        assert!(
            input("DATE", Some(date!(2026 - 05 - 03)), None, None)
                .first_date()
                .is_err()
        );
        assert_eq!(
            input("YEARLY", None, Some(2), Some(31)).first_date(),
            Err("holiday_rule_invalid")
        );
        assert!(input("DATE", None, Some(1), Some(1)).first_date().is_err());
    }
}
