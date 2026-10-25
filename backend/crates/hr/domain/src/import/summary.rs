//! W02 / W03: what the dry run counts so the apply button can name it — the
//! labels the catalog mapped without asking, the new people who come in with
//! no 고용형태, and the 미배치 people by reason.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::classification::import_header_match_key;
use super::normalize::employment_type_code;
use super::plan::{Decisions, ImportRow, PlannedRow};

/// A label mapped by the catalog, shown so the operator can override it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AutoMapped {
    pub field: &'static str,
    pub value: String,
    pub code: &'static str,
    pub rows: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Unplaced {
    pub rows: usize,
    pub by_reason: BTreeMap<String, usize>,
}

/// Every 고용형태 label of an imported row the catalog mapped (not a code,
/// not the operator's answer), with its row count.
#[must_use]
pub fn auto_mapped(
    rows: &[ImportRow],
    plans: &[PlannedRow],
    decisions: &Decisions,
) -> Vec<AutoMapped> {
    let mut found = BTreeMap::<(&str, &'static str), usize>::new();
    for (row, plan) in rows.iter().zip(plans) {
        let Some(text) = row.employment_type.as_deref() else {
            continue;
        };
        if !matches!(plan.outcome, "insert" | "update" | "unchanged")
            || decisions.employment_type_map.contains_key(text)
        {
            continue;
        }
        if let Some(code) = employment_type_code(text)
            && import_header_match_key(code) != import_header_match_key(text)
        {
            *found.entry((text, code)).or_default() += 1;
        }
    }
    found
        .into_iter()
        .map(|((value, code), rows)| AutoMapped {
            field: "employment_type",
            value: value.to_owned(),
            code,
            rows,
        })
        .collect()
}

/// New people who come in with no 고용형태 (an empty cell or the operator's
/// `null`): the count the apply button names.
#[must_use]
pub fn employment_type_empty_rows(plans: &[PlannedRow]) -> usize {
    plans
        .iter()
        .filter_map(|p| p.new_person.as_ref().filter(|_| p.outcome == "insert"))
        .filter(|person| person.employment_type.is_none())
        .count()
}

/// W12: rows whose 휴대전화 is not stored. It lives on the employment
/// profile, so a new person needs a 고용형태; a person on file is never
/// changed by an import (their phone is changed on the 인사카드).
#[must_use]
pub fn phone_unstored_rows(rows: &[ImportRow], plans: &[PlannedRow]) -> usize {
    rows.iter()
        .zip(plans)
        .filter(|(row, plan)| {
            row.has_phone
                && match plan.outcome {
                    "insert" => plan
                        .new_person
                        .as_ref()
                        .is_some_and(|p| p.employment_type.is_none()),
                    "update" | "unchanged" => true,
                    _ => false,
                }
        })
        .count()
}

/// New people who come in 미배치, by reason.
#[must_use]
pub fn unplaced(plans: &[PlannedRow]) -> Unplaced {
    let mut out = Unplaced::default();
    for reason in plans
        .iter()
        .filter(|p| p.outcome == "insert")
        .filter_map(|p| p.new_person.as_ref())
        .filter(|person| person.workplace_id.is_none())
        .filter_map(|person| person.unplaced_reason)
    {
        out.rows += 1;
        *out.by_reason.entry(reason.to_owned()).or_default() += 1;
    }
    out
}
