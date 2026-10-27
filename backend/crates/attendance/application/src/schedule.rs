//! 근무 일정 (ATT S1) commands and read models. The wire shapes are these
//! structs serialised as they are (openapi `Attendance*` schemas).

use console_attendance_domain::schedule::{HolidayRule, Level, PatternSpec};
use serde::{Deserialize, Serialize};
use time::{Date, OffsetDateTime};
use uuid::Uuid;

time::serde::format_description!(iso_date, Date, "[year]-[month]-[day]");

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PatternInput {
    pub name: String,
    #[serde(deserialize_with = "deserialize_enum_6")]
    pub kind: String,
    #[serde(default)]
    pub holiday_rule: Option<HolidayRule>,
    #[serde(default)]
    pub days: Option<serde_json::Value>,
    #[serde(default)]
    pub slots: Option<serde_json::Value>,
    #[serde(default)]
    pub start_choices: Option<Vec<u16>>,
}

/// What is stored in `attendance_work_patterns.spec`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredSpec {
    #[serde(flatten)]
    pub pattern: PatternSpec,
    #[serde(default)]
    pub holiday_rule: HolidayRule,
}

#[derive(Debug, Clone, Serialize)]
pub struct PatternRead {
    pub id: Uuid,
    pub name: String,
    #[serde(flatten)]
    pub spec: StoredSpec,
    pub weekly_minutes: i32,
    pub cycle_days: i16,
    pub night_work: bool,
    pub status: String,
    pub people_today: i64,
    pub layers_active: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    pub created_by_name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Items<T> {
    pub items: Vec<T>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LayerSummary {
    pub layer_id: Uuid,
    pub pattern_id: Uuid,
    pub pattern_name: String,
    #[serde(with = "iso_date")]
    pub effective_from: Date,
    #[serde(with = "iso_date::option")]
    pub effective_to: Option<Date>,
    pub version: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct EffectiveLayer {
    #[serde(flatten)]
    pub layer: LayerSummary,
    pub from: Level,
}

#[derive(Debug, Clone, Serialize)]
pub struct TreeNode {
    pub kind: Level,
    pub id: Uuid,
    pub parent_id: Option<Uuid>,
    pub workplace_id: Option<Uuid>,
    pub name: String,
    pub people: i64,
    pub layer: Option<LayerSummary>,
    pub effective: Option<EffectiveLayer>,
    pub unscheduled: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScheduleTree {
    #[serde(skip)]
    pub access_subject_employees: Vec<Uuid>,
    #[serde(with = "iso_date")]
    pub date: Date,
    pub nodes: Vec<TreeNode>,
    pub people_total: i64,
    pub people_unscheduled: i64,
    pub holidays_loaded: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct StackEntry {
    pub level: Level,
    pub scope_id: Option<Uuid>,
    pub scope_name: Option<String>,
    pub layer: Option<LayerSummary>,
    pub wins: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ShiftRead {
    pub start: u16,
    pub end: u16,
    pub breaks: Vec<console_attendance_domain::schedule::Window>,
    pub minutes: u16,
    pub night_minutes: u16,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScheduleDay {
    #[serde(with = "iso_date")]
    pub date: Date,
    pub kind: console_attendance_domain::schedule::DayKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shift: Option<ShiftRead>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slot_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub holiday_name: Option<String>,
    pub holiday_work: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decided_by: Option<Level>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layer_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScheduleCalendar {
    pub scope_kind: Level,
    pub scope_id: Uuid,
    pub scope_name: String,
    pub month: String,
    pub stack: Vec<StackEntry>,
    pub upcoming: Vec<LayerSummary>,
    pub days: Vec<ScheduleDay>,
    pub holidays_loaded: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct LayerRead {
    #[serde(skip)]
    pub access_subject_users: Vec<Uuid>,
    pub id: Uuid,
    pub scope_kind: Level,
    pub scope_id: Uuid,
    pub scope_name: String,
    pub pattern_id: Uuid,
    pub pattern_name: String,
    #[serde(with = "iso_date")]
    pub effective_from: Date,
    #[serde(with = "iso_date::option")]
    pub effective_to: Option<Date>,
    #[serde(with = "iso_date::option")]
    pub rotation_start: Option<Date>,
    pub start_choice: Option<i16>,
    pub reason: String,
    pub evidence_ref: Option<String>,
    pub version: i32,
    pub state: &'static str,
    pub cancel_reason: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    pub created_by_name: String,
    #[serde(with = "time::serde::rfc3339::option")]
    pub cancelled_at: Option<OffsetDateTime>,
    pub cancelled_by_name: Option<String>,
}

/// 예정 · 적용 중 · 지난 일정 · 취소됨, from the layer's dates and its
/// successor's start at the same scope.
#[must_use]
pub fn layer_state(
    cancelled: bool,
    from: Date,
    to: Option<Date>,
    next_from: Option<Date>,
    today: Date,
) -> &'static str {
    let end = match (to, next_from) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    };
    if cancelled {
        "CANCELLED"
    } else if from > today {
        "SCHEDULED"
    } else if end.is_some_and(|e| e <= today) {
        "ENDED"
    } else {
        "IN_EFFECT"
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssignTarget {
    pub scope_kind: Level,
    pub scope_id: Uuid,
    #[serde(default, with = "iso_date::option")]
    pub rotation_start: Option<Date>,
    #[serde(default)]
    pub start_choice: Option<u16>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssignInput {
    pub targets: Vec<AssignTarget>,
    pub pattern_id: Uuid,
    #[serde(with = "iso_date")]
    pub effective_from: Date,
    #[serde(default, with = "iso_date::option")]
    pub effective_to: Option<Date>,
    #[serde(deserialize_with = "deserialize_enum_5")]
    pub reason: String,
    #[serde(default)]
    pub evidence_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Kept {
    pub level: Level,
    pub people: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Refusal {
    pub code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SchedulePreview {
    pub people_in_scope: i64,
    pub people_changed: i64,
    pub kept: Vec<Kept>,
    pub closed_months: Vec<String>,
    pub past_from: bool,
    pub night_work: bool,
    pub weekly_minutes: i32,
    pub unscheduled_after: i64,
    pub refusals: Vec<Refusal>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AssignReceipt {
    pub layers: Vec<LayerRead>,
    pub people_changed: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReasonInput {
    pub reason: String,
}

fn deserialize_enum_5<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_enum_string(
        deserializer,
        &["STANDARD", "REDUCTION", "SUBSTITUTE", "TEMPORARY"],
    )
}

fn deserialize_enum_6<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_enum_string(
        deserializer,
        &[
            "WEEKLY",
            "ROTATION",
            "STAGGERED",
            "FLEXIBLE",
            "SELECTIVE",
            "DEEMED",
            "DISCRETIONARY",
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::date;

    #[test]
    fn layer_state_follows_dates_and_successors() {
        let today = date!(2026 - 10 - 09);
        let s = |c, f, t, n| layer_state(c, f, t, n, today);
        assert_eq!(s(true, date!(2026 - 11 - 01), None, None), "CANCELLED");
        assert_eq!(s(false, date!(2026 - 11 - 01), None, None), "SCHEDULED");
        assert_eq!(
            s(
                false,
                date!(2026 - 03 - 01),
                None,
                Some(date!(2026 - 11 - 01))
            ),
            "IN_EFFECT"
        );
        assert_eq!(
            s(
                false,
                date!(2026 - 03 - 01),
                None,
                Some(date!(2026 - 10 - 09))
            ),
            "ENDED"
        );
        assert_eq!(
            s(
                false,
                date!(2026 - 10 - 08),
                Some(date!(2026 - 10 - 09)),
                None
            ),
            "ENDED"
        );
    }

    #[test]
    fn stored_spec_round_trips_with_its_holiday_rule() {
        let raw = serde_json::json!({"kind": "WEEKLY", "days": [], "holiday_rule": "WORK"});
        let spec: StoredSpec = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(spec.holiday_rule, HolidayRule::Work);
        assert_eq!(serde_json::to_value(&spec).unwrap(), raw);
    }
}
