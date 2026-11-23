// SPDX-License-Identifier: LicenseRef-Proprietary
//! Pre-hire identity checks, inline cell repair overlays, and date error mapping for import plans.

use std::collections::BTreeMap;

use time::Date;

use crate::profile::enums::IdType;
use crate::profile::identity::{
    parse_id_type_import, validate_id_pair, validate_id_type_for_status,
};

use super::cells::{DateParseError, name_key, parse_import_date_checked};
use super::normalize::employee_number;
use super::plan::{Decisions, ImportRow, PlanFacts};
use super::sex::sex_of_text;

/// Date parse result mapped to the import plan refusal code.
pub(super) fn parse_plan_date(
    raw: &str,
    field: &'static str,
) -> Result<Date, (&'static str, &'static str)> {
    match parse_import_date_checked(raw) {
        Ok(date) => Ok(date),
        Err(DateParseError::TwoDigitYear) => Err(("two_digit_year", field)),
        Err(DateParseError::InvalidFormat) => Err(("invalid_date", field)),
    }
}

/// Fields that are never eligible for inline dry-run cell repair.
pub const FORBIDDEN_CELL_REPAIR_TARGETS: [&str; 3] = ["rrn", "phone", "name"];

/// Apply in-memory inline cell repairs from `decisions.cells` onto candidate rows.
pub(super) fn apply_cell_overrides(rows: &[ImportRow], decisions: &Decisions) -> Vec<ImportRow> {
    if decisions.cells.is_empty() {
        return rows.to_vec();
    }
    rows.iter()
        .map(|row| {
            let Some(repairs) = decisions.cells.get(&row.source_key) else {
                return row.clone();
            };
            let mut next = row.clone();
            for (field, raw) in repairs {
                let value = raw.trim();
                let opt = (!value.is_empty()).then(|| value.to_owned());
                match field.as_str() {
                    "employee_number" => {
                        next.employee_number = opt.as_deref().and_then(employee_number);
                    }
                    "hire_date" => next.hire_date = opt,
                    "exit_date" => next.exit_date = opt,
                    "birth_date" => next.birth_date = opt,
                    "org_unit" => next.org_unit = opt,
                    "job" => next.job = opt,
                    "position" => next.position = opt,
                    "workplace" => next.workplace = opt,
                    "worksite_name" => next.worksite_name = opt,
                    "worksite_address" => next.worksite_address = opt,
                    "employment_type" => next.employment_type = opt,
                    "employment_status" => next.status = opt,
                    "leave_start_date" => next.leave_start_date = opt,
                    "leave_type" => next.leave_type = opt,
                    "leave_return_date" => next.leave_return_date = opt,
                    "contract_end_date" => next.contract_end_date = opt,
                    "probation_end_date" => next.probation_end_date = opt,
                    "sex" => {
                        next.sex = opt
                            .as_deref()
                            .and_then(sex_of_text)
                            .map(str::to_owned)
                            .or(opt);
                    }
                    "id_type" => next.id_type = opt,
                    "company" => next.company = opt.unwrap_or_default(),
                    "company_brn" => next.company_brn = opt,
                    _ => {}
                }
            }
            next
        })
        .collect()
}

pub(super) fn row_has_rrn(row: &ImportRow) -> bool {
    row.has_rrn
        || row.rrn_hmac.is_some()
        || row.rrn_hmac_v2.is_some()
        || !row.rrn_hmac_v2_candidates.is_empty()
}

/// Validate explicit `id_type` syntax and optional status/RRN-digit compatibility before
/// identification.
pub(super) fn validate_row_id_precheck(
    row: &ImportRow,
    explicit_status: Option<&str>,
) -> Result<Option<IdType>, (&'static str, &'static str)> {
    if let Some(err_code) = row.rrn_validation_error.as_deref() {
        let code = if err_code == "rrn_mod11_invalid" {
            "rrn_mod11_invalid"
        } else {
            "rrn_invalid"
        };
        return Err((code, "rrn"));
    }
    let explicit = match row.id_type.as_deref() {
        Some(raw) if !raw.trim().is_empty() => match parse_id_type_import(raw) {
            Some(parsed) => Some(parsed),
            None => return Err(("id_type_invalid", "id_type")),
        },
        _ => None,
    };
    if explicit == Some(IdType::NotIssued) && row_has_rrn(row) {
        return Err(("not_issued_with_rrn", "id_type"));
    }
    let inferred_digit = match row.inferred_id_type.as_deref() {
        Some("RRN") => Some(1),
        Some("ARC") => Some(5),
        _ => None,
    };
    validate_id_pair(explicit, inferred_digit, true, explicit_status)
        .map_err(|code| (code, "id_type"))
}

/// Validate full `id_type` compatibility for a resolved target employment status.
pub(super) fn resolve_new_person_id_type(
    row: &ImportRow,
    status: &str,
    birth: Option<Date>,
    facts: &PlanFacts<'_>,
    decisions: &Decisions,
) -> Result<Option<IdType>, (&'static str, &'static str)> {
    let effective = validate_row_id_precheck(row, Some(status))?;
    validate_id_type_for_status(effective, status).map_err(|code| (code, "id_type"))?;
    if effective == Some(IdType::NotIssued) {
        let has_emp_no = row.employee_number.is_some()
            || decisions.employee_numbers.contains_key(&row.source_key);
        if birth.is_none() && !has_emp_no {
            return Err(("not_issued_secondary_key_required", "birth_date"));
        }
        if let Some(b) = birth {
            let key = name_key(&row.name);
            let roster_conflict = facts.people.iter().any(|p| {
                p.status == "PRE_HIRE"
                    && p.id_type.as_deref() == Some("NOT_ISSUED")
                    && p.birth_date == Some(b)
                    && name_key(&p.name) == key
            });
            if roster_conflict {
                return Err(("duplicate_in_file", "birth_date"));
            }
        }
    }
    Ok(effective)
}

/// Whether `row` is a valid non-RRN `PRE_HIRE + NOT_ISSUED` candidate for duplicate checking.
pub(super) fn is_pre_hire_not_issued_candidate(
    row: &ImportRow,
    facts: &PlanFacts<'_>,
    decisions: &Decisions,
) -> bool {
    let explicit = row.id_type.as_deref().and_then(parse_id_type_import);
    if explicit != Some(IdType::NotIssued) || row_has_rrn(row) {
        return false;
    }
    let Some(hire) = row
        .hire_date
        .as_deref()
        .and_then(|raw| parse_plan_date(raw, "hire_date").ok())
    else {
        return false;
    };
    let exit = match row.exit_date.as_deref() {
        Some(raw) => match parse_plan_date(raw, "exit_date") {
            Ok(date) => Some(date),
            Err(_) => return false,
        },
        None => None,
    };
    matches!(
        super::plan_status::new_status(row, (hire, exit), facts, decisions),
        Ok(("PRE_HIRE", _))
    )
}

/// Count duplicate `(name_key, birth_date)` keys among non-excluded `PRE_HIRE + NOT_ISSUED` rows in
/// one file.
pub(super) fn not_issued_key_counts(
    rows: &[ImportRow],
    facts: &PlanFacts<'_>,
    decisions: &Decisions,
) -> BTreeMap<(String, Date), usize> {
    let mut counts: BTreeMap<(String, Date), usize> = BTreeMap::new();
    for row in rows {
        if is_pre_hire_not_issued_candidate(row, facts, decisions)
            && let Some(raw_birth) = row.birth_date.as_deref()
            && let Ok(birth) = parse_import_date_checked(raw_birth)
        {
            *counts.entry((name_key(&row.name), birth)).or_default() += 1;
        }
    }
    counts
}

#[cfg(test)]
#[path = "plan_cells_id_tests.rs"]
mod tests;
