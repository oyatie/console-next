//! BW-10 the planner's two person checks: who a row without a 사번 may be,
//! and what a row does to the person its 사번 (or the operator's pick) names.

use super::cells::name_key;
use super::plan::{
    Candidate, Decisions, Deferred, FieldChange, ImportRow, OnFile, PlanFacts, PlannedRow,
};
use super::plan_identity::candidate;
use super::plan_place;
use super::plan_rows::refused;
use super::plan_status::status_of;

/// People of the same name (spaces ignored) a row without a 사번 may be; a
/// differing 생년월일 rules one out.
pub(super) fn unresolved(
    base: PlannedRow,
    row: &ImportRow,
    birth: Option<time::Date>,
    facts: &PlanFacts<'_>,
) -> PlannedRow {
    let key = name_key(&row.name);
    let candidates: Vec<Candidate> = facts
        .people
        .iter()
        .filter(|p| name_key(&p.name) == key)
        .filter_map(|p| {
            let basis = match (birth, p.birth_date) {
                (Some(a), Some(b)) if a == b => "name_birth_date",
                (Some(_), Some(_)) => return None,
                _ => "name_only",
            };
            Some(candidate(p, basis))
        })
        .collect();
    PlannedRow {
        outcome: "unresolved_identity",
        candidates,
        ..base
    }
}

pub(super) fn existing(
    base: PlannedRow,
    row: &ImportRow,
    person: &OnFile,
    hire: Option<time::Date>,
    birth: Option<time::Date>,
    decisions: &Decisions,
    facts: &PlanFacts<'_>,
) -> PlannedRow {
    if name_key(&row.name) != name_key(&person.name) {
        return refused(base, "identity_mismatch", "name");
    }
    if let (Some(a), Some(b)) = (birth, person.birth_date)
        && a != b
    {
        return refused(base, "identity_mismatch", "birth_date");
    }
    if hire.is_some_and(|hire| {
        !person.period_starts.is_empty() && !person.period_starts.contains(&hire)
    }) {
        return refused(base, "identity_mismatch", "hire_date");
    }
    if let (Some(a), Some(b)) = (&row.rrn_hmac, &person.rrn_hmac)
        && a != b
    {
        return refused(base, "identity_mismatch", "rrn");
    }
    let mut diff = Vec::new();
    for (field, file, on_file) in [
        ("job", &row.job, &person.job),
        ("position", &row.position, &person.position),
        ("worksite_name", &row.worksite_name, &person.worksite_name),
        (
            "worksite_address",
            &row.worksite_address,
            &person.worksite_address,
        ),
    ] {
        if let Some(to) = file
            && Some(to) != on_file.as_ref()
        {
            diff.push(FieldChange {
                field,
                from: on_file.clone(),
                to: to.clone(),
            });
        }
    }
    if let (Some(birth), None) = (birth, person.birth_date) {
        diff.push(FieldChange {
            field: "birth_date",
            from: None,
            to: birth.to_string(),
        });
    }
    let mut deferred = Vec::new();
    // 고용형태 fills an empty profile (the person has none yet, MR-7); a
    // different one is a 정정 (BW-18), never an import overwrite.
    let (kind, unmapped) = plan_place::employment_type(row.employment_type.as_ref(), decisions);
    deferred.extend(unmapped);
    match (kind, &person.employment_type) {
        (Some(to), None) => diff.push(FieldChange {
            field: "employment_type",
            from: None,
            to,
        }),
        (Some(to), Some(on_file)) if &to != on_file => deferred.push(Deferred {
            field: "employment_type",
            from: Some(on_file.clone()),
            to: Some(to),
            route: "correction",
        }),
        _ => {}
    }
    // r3:worst-case-22: a 법인 the file names that is not the person's is a
    // 전적 (or a mistake in the file), never a 발령: a 전보 cannot cross a
    // 법인, and the import never moves anyone between 법인.
    let entity_moves = person
        .workplace_id
        .zip(
            facts
                .company_workplaces
                .get(&super::company_review::company_key(row)),
        )
        .is_some_and(|(from, places)| !places.contains(&from));
    if entity_moves {
        deferred.push(Deferred {
            field: "company",
            from: Some(person.company.clone()),
            to: Some(row.company.clone()),
            route: "entity_transfer",
        });
    }
    if let Some(unit) = &row.org_unit
        && Some(unit) != person.org_unit.as_ref()
    {
        deferred.push(Deferred {
            field: "org_unit",
            from: person.org_unit.clone(),
            to: Some(unit.clone()),
            route: if entity_moves {
                "entity_transfer"
            } else {
                "lifecycle_transfer"
            },
        });
    }
    deferred.extend(status_and_number(row, person, decisions));
    match (person.status.as_str(), &row.exit_date) {
        ("EXITED", None) => deferred.push(Deferred {
            field: "employment_status",
            from: Some(person.status.clone()),
            to: None,
            route: "rehire",
        }),
        ("EXITED", Some(_)) => {}
        (_, Some(exit)) => deferred.push(Deferred {
            field: "exit_date",
            from: person.exit_date.map(|d| d.to_string()),
            to: Some(exit.clone()),
            route: "exit_case",
        }),
        _ => {}
    }
    PlannedRow {
        outcome: if diff.is_empty() {
            "unchanged"
        } else {
            "update"
        },
        employee_id: Some(person.id),
        employee_number: person.employee_number.clone(),
        observed: Some(person.observed.clone()),
        diff,
        deferred,
        ..base
    }
}

/// IMPORT-2: a stated status or a 사번 that differs from the person on file
/// is never written by import; it comes back with the flow that does it.
fn status_and_number(row: &ImportRow, person: &OnFile, decisions: &Decisions) -> Vec<Deferred> {
    let mut out = Vec::new();
    if let Ok(Some(status)) = status_of(row, decisions)
        && status != person.status
        && !matches!(
            (status, person.status.as_str()),
            ("EXITED", _) | (_, "EXITED")
        )
    {
        out.push(Deferred {
            field: "employment_status",
            from: Some(person.status.clone()),
            to: Some(status.to_owned()),
            route: if status == "ON_LEAVE" {
                "leave"
            } else {
                "lifecycle"
            },
        });
    }
    if let Some(number) = &row.employee_number
        && person.employee_number.as_ref() != Some(number)
        && !person.aliases.contains(number)
    {
        out.push(Deferred {
            field: "employee_number",
            from: person.employee_number.clone(),
            to: Some(number.clone()),
            route: "employee_number_change",
        });
    }
    out
}
