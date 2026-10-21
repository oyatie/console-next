//! W05: one answer for every row with the same refusal — `group_exclusions`
//! keyed `reason` or `reason:field` (`invalid_date:hire_date`) leaves all of
//! them out with one reason code, instead of one exclusion per row. A row's
//! own exclusion wins; the stored decisions make the apply re-plan identical.

use serde::Serialize;

use super::detect::known_target;
use super::plan::{Decisions, Exclusion, PlannedRow};
use super::review::{Resolution, ReviewItem};

/// The row-level reasons a group answer may name.
pub const GROUP_REASONS: [&str; 15] = [
    "invalid_date",
    "hire_date_required",
    "duplicate_in_file",
    "employee_number_taken",
    "workplace_conflict",
    "identity_conflict",
    "identity_mismatch",
    "status_unmapped",
    "status_conflict",
    "leave_type_unmapped",
    "leave_start_required",
    "leave_return_required",
    "exit_date_required",
    "former_load_closed",
    "unresolved_identity",
];

/// The group key of a row the plan did not settle: `reason:field`, and the
/// bare `reason`.
fn keys(row: &PlannedRow) -> Option<(String, String)> {
    let reason = match (row.outcome, row.refusal_code) {
        ("refused", Some(code)) => code,
        ("unresolved_identity", _) => "unresolved_identity",
        _ => return None,
    };
    let field = row.refusal_field.unwrap_or("name");
    Some((format!("{reason}:{field}"), reason.to_owned()))
}

/// A group key the operator may send: a known reason, optionally `:` a
/// known import target.
#[must_use]
pub fn group_key_ok(key: &str) -> bool {
    let (reason, field) = key
        .split_once(':')
        .map_or((key, None), |(r, f)| (r, Some(f)));
    GROUP_REASONS.contains(&reason) && field.is_none_or(|f| known_target(f).is_some())
}

/// The group key a review item of `reason` / `field` is answered under.
#[must_use]
pub fn group_key(reason: &str, field: Option<&str>) -> String {
    format!("{reason}:{}", field.unwrap_or("name"))
}

pub(super) fn apply(planned: &mut [PlannedRow], decisions: &Decisions) {
    if decisions.group_exclusions.is_empty() {
        return;
    }
    for row in planned.iter_mut() {
        let Some((exact, reason)) = keys(row) else {
            continue;
        };
        let answer: Option<&Exclusion> = decisions
            .group_exclusions
            .get(&exact)
            .or_else(|| decisions.group_exclusions.get(&reason));
        if let Some(exclusion) = answer {
            row.outcome = "excluded";
            row.exclusion_code = Some(exclusion.reason_code.clone());
            row.refusal_code = None;
            row.refusal_field = None;
            row.candidates.clear();
        }
    }
}

/// One answer for many review items (W05).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReviewGroup {
    /// The `group_exclusions` key that answers every item of the group.
    pub key: String,
    pub reason: &'static str,
    pub field: &'static str,
    pub rows: usize,
    pub blocking: bool,
    pub resolution: Resolution,
}

/// Every row-level reason that covers two or more rows, as one answer.
#[must_use]
pub fn review_groups(items: &[ReviewItem]) -> Vec<ReviewGroup> {
    let mut groups: Vec<ReviewGroup> = Vec::new();
    for item in items {
        let row_level = item
            .resolution
            .as_ref()
            .is_some_and(|r| matches!(r.decision, "exclusions" | "identity") && item.row.is_some());
        if !row_level || !GROUP_REASONS.contains(&item.reason) {
            continue;
        }
        let field = item.field.unwrap_or("name");
        let key = group_key(item.reason, Some(field));
        match groups.iter_mut().find(|g| g.key == key) {
            Some(group) => group.rows += 1,
            None => groups.push(ReviewGroup {
                resolution: Resolution {
                    decision: "group_exclusions",
                    key: key.clone(),
                    choices: Vec::new(),
                },
                key,
                reason: item.reason,
                field,
                rows: 1,
                blocking: item.blocking,
            }),
        }
    }
    groups.retain(|g| g.rows > 1);
    groups
}
