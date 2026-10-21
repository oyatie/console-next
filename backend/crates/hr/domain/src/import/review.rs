//! IMPORT-2 (decisions #25): the 「확인 필요」 queue — every item of a run
//! that needs a person, counted, with its reason, the source sheet and cell,
//! and the one decision that resolves it (the FE sends that entry in the
//! next dry run). A projection of the plan, never stored on its own.
//! `blocking` items keep apply closed; the rest come in as the plan says
//! (미배치, 사번 미부여) and stay listed.

use std::collections::BTreeMap;

use serde::Serialize;

use super::names::NameCandidate;
use super::normalize::employment_type_choices;
use super::plan::{ImportRow, PlannedRow};
use super::plan_group::{ReviewGroup, review_groups};
use super::review_values::{EMPLOYMENT_TYPE, LEAVE, STATUS, UNIT, ValueMap, WORKPLACE};

/// What resolves an item: set `decisions[decision][key]` to one of
/// `choices` (an empty list: a value the operator types or picks).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Resolution {
    pub decision: &'static str,
    pub key: String,
    pub choices: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReviewItem {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_column: Option<String>,
    pub id: String,
    pub reason: &'static str,
    pub blocking: bool,
    pub sheet: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row: Option<i32>,
    /// `B14`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cell: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<&'static str>,
    /// The text to map (a unit, 사업장, 고용형태, 재직상태 or 휴직 유형 text).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    /// Rows the item covers (a value map covers every row with that text).
    pub rows: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution: Option<Resolution>,
    /// W03: the records a unit / 사업장 text may mean (`names`), best first.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub candidates: Vec<NameCandidate>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ReviewQueue {
    pub count: usize,
    pub blocking: usize,
    pub items: Vec<ReviewItem>,
    /// W05: one answer (`group_exclusions`) for each row-level reason that
    /// covers two or more rows.
    pub groups: Vec<ReviewGroup>,
}

/// A sheet-level item (`sheet_needs_mapping`, `rrn_unavailable`) or a cell
/// the parse could not keep (`rrn_invalid`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Note {
    pub reason: &'static str,
    pub blocking: bool,
    pub sheet: String,
    pub row: Option<i32>,
    pub cell: Option<String>,
}

fn resolution(decision: &'static str, key: &str, choices: Vec<String>) -> Option<Resolution> {
    Some(Resolution {
        decision,
        key: key.to_owned(),
        choices,
    })
}

struct Builder<'a> {
    items: Vec<ReviewItem>,
    grouped: BTreeMap<(&'static str, String), usize>,
    cell: &'a dyn Fn(&str, &str) -> Option<String>,
}

impl Builder<'_> {
    fn row(
        &mut self,
        plan: &PlannedRow,
        reason: &'static str,
        blocking: bool,
        field: Option<&'static str>,
        res: Option<Resolution>,
    ) {
        self.items.push(ReviewItem {
            source_column: None,
            id: match field {
                Some(field) => format!("{}#{reason}:{field}", plan.source_key),
                None => format!("{}#{reason}", plan.source_key),
            },
            reason,
            blocking,
            sheet: plan.sheet.clone(),
            row: Some(plan.row),
            cell: field.and_then(|f| (self.cell)(&plan.source_key, f)),
            field,
            value: None,
            rows: 1,
            resolution: res,
            candidates: Vec::new(),
        });
    }

    fn value(&mut self, plan: &PlannedRow, map: &ValueMap, text: &str) {
        let ValueMap {
            reason,
            blocking,
            decision,
            field,
            choices,
        } = *map;
        let group = (decision, text.to_owned());
        if let Some(at) = self.grouped.get(&group) {
            self.items[*at].rows += 1;
            return;
        }
        self.grouped.insert(group, self.items.len());
        self.items.push(ReviewItem {
            source_column: None,
            id: format!("{decision}#{text}"),
            reason,
            blocking,
            sheet: plan.sheet.clone(),
            row: Some(plan.row),
            cell: (self.cell)(&plan.source_key, field),
            field: Some(field),
            value: Some(text.to_owned()),
            rows: 1,
            resolution: resolution(
                decision,
                text,
                if decision == EMPLOYMENT_TYPE.decision {
                    employment_type_choices(text)
                } else {
                    choices.to_vec()
                }
                .into_iter()
                .map(ToOwned::to_owned)
                .collect(),
            ),
            candidates: Vec::new(),
        });
    }
}

/// The queue of a planned run. `cell(source_key, field)` names a row's cell.
#[must_use]
pub fn review_queue(
    rows: &[ImportRow],
    plans: &[PlannedRow],
    notes: &[Note],
    cell: &dyn Fn(&str, &str) -> Option<String>,
) -> ReviewQueue {
    let mut b = Builder {
        items: Vec::new(),
        grouped: BTreeMap::new(),
        cell,
    };
    for note in notes {
        let id = format!("sheet:{}#{}", note.sheet, note.reason);
        let res = (note.reason == "sheet_needs_mapping").then(|| Resolution {
            decision: "mapping",
            key: note.sheet.clone(),
            choices: Vec::new(),
        });
        b.items.push(ReviewItem {
            source_column: None,
            id: note.row.map_or(id.clone(), |r| format!("{id}@{r}")),
            reason: note.reason,
            blocking: note.blocking,
            sheet: note.sheet.clone(),
            row: note.row,
            cell: note.cell.clone(),
            field: None,
            value: None,
            rows: 1,
            resolution: res,
            candidates: Vec::new(),
        });
    }
    for (row, plan) in rows.iter().zip(plans) {
        let ids = || {
            plan.candidates
                .iter()
                .map(|c| c.employee_id.to_string())
                .collect::<Vec<_>>()
        };
        match (plan.outcome, plan.refusal_code) {
            ("unresolved_identity", _) => {
                let mut choices = ids();
                choices.push("new".into());
                b.row(
                    plan,
                    "unresolved_identity",
                    true,
                    Some("name"),
                    resolution("identity", &plan.source_key, choices),
                );
            }
            ("refused", Some("status_unmapped")) => {
                let text = row.status.clone().unwrap_or_default();
                b.value(plan, &STATUS, &text);
            }
            ("refused", Some("leave_type_unmapped")) => {
                let text = row.leave_type.clone().unwrap_or_default();
                b.value(plan, &LEAVE, &text);
            }
            ("refused", Some(code @ ("identity_conflict" | "identity_mismatch"))) => {
                b.row(
                    plan,
                    code,
                    true,
                    plan.refusal_field,
                    resolution("identity", &plan.source_key, ids()),
                );
            }
            ("refused", Some(code)) => {
                b.row(
                    plan,
                    code,
                    true,
                    plan.refusal_field,
                    resolution("exclusions", &plan.source_key, Vec::new()),
                );
            }
            _ => {}
        }
        if let Some(text) = &plan.unit_name {
            b.value(plan, &UNIT, text);
        }
        if let Some(text) = &plan.workplace_name {
            b.value(plan, &WORKPLACE, text);
        }
        for deferred in &plan.deferred {
            match (deferred.route, &deferred.to) {
                ("value_map", Some(text)) => {
                    b.value(plan, &EMPLOYMENT_TYPE, text);
                }
                _ => b.row(plan, "deferred_change", false, Some(deferred.field), None),
            }
        }
        if plan
            .new_person
            .as_ref()
            .is_some_and(|p| p.employee_number.is_none())
        {
            b.row(
                plan,
                "employee_number_missing",
                false,
                Some("employee_number"),
                resolution("employee_numbers", &plan.source_key, Vec::new()),
            );
        }
    }
    let mut items = b.items;
    items.sort_by_key(|item| !item.blocking);
    ReviewQueue {
        count: items.len(),
        blocking: items.iter().filter(|i| i.blocking).count(),
        groups: review_groups(&items),
        items,
    }
}

#[cfg(test)]
#[path = "review_tests.rs"]
mod tests;
