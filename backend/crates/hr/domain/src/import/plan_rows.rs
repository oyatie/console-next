//! BW-10 the planner: every candidate row of a run → one [`PlannedRow`].
//!
//! 1. An excluded row is only excluded.
//! 2. A 사번 used twice in the file, or two rows that resolve to one person,
//!    are refused (`duplicate_in_file`): nobody guesses which row wins.
//! 3. A 사번 on file is that person: an update of the fields import may write
//!    (업무, 직위, 근무지, an empty 생년월일 or 고용형태), never of name, status, 퇴직일,
//!    부서 or 법인 — those come back as `deferred` with the flow that does
//!    them. A name, 생년월일 or 입사일 that contradicts the person on file is
//!    `identity_mismatch` (a 정정 request, BW-17).
//! 4. A row without a 사번 that resembles people on file waits for the
//!    operator's pick (`unresolved_identity`); never an automatic name match.
//! 5. A new person needs a valid 입사일; a future one is 입사 예정 (PRE_HIRE);
//!    a 퇴직일 loads a former employee as EXITED only while no payroll period
//!    is approved. A current one is bound to the unit its name resolves to
//!    (or the operator's mapping), else comes in 미배치 with the name kept;
//!    it is placed at the 사업장 of the unit, else of the 사업장 text, and a
//!    unit and a 사업장 text that disagree are refused (MR-7).
//! 6. IMPORT-2: identity is the 사번 or an alias, then the 주민등록번호 hash
//!    (`plan_identity`); a stated 재직상태 (휴직 with its start) is a setup
//!    fact of a new person (`plan_status`); a new person without a 사번 gets
//!    the rule's next number in the preview, or none (「사번 미부여」).

use std::collections::BTreeMap;

use super::cells::parse_import_date;
use super::numbering::Numbering;
use super::plan::{Decisions, ImportRow, NewPerson, PlanFacts, PlannedRow};
use super::plan_group;
use super::plan_identity::{Identity, identify};
use super::plan_people::existing;
use super::plan_place;
use super::plan_status;

pub(super) fn refused(mut row: PlannedRow, code: &'static str, field: &'static str) -> PlannedRow {
    row.outcome = "refused";
    row.refusal_code = Some(code);
    row.refusal_field = Some(field);
    row
}

/// The plan of every row, in file order.
#[must_use]
pub fn plan_rows(
    rows: &[ImportRow],
    facts: &PlanFacts<'_>,
    decisions: &Decisions,
) -> Vec<PlannedRow> {
    let mut numbers: BTreeMap<&str, usize> = BTreeMap::new();
    for row in rows {
        if let Some(number) = row.employee_number.as_deref() {
            *numbers.entry(number).or_default() += 1;
        }
    }
    let mut planned: Vec<PlannedRow> = rows
        .iter()
        .map(|row| {
            let twice = row
                .employee_number
                .as_deref()
                .is_some_and(|number| numbers[number] > 1);
            plan_row(row, twice, facts, decisions)
        })
        .collect();
    // Two rows that resolve to one person (a 사번 and a pick, or two picks).
    let mut targets: BTreeMap<uuid::Uuid, usize> = BTreeMap::new();
    for row in &planned {
        if let (Some(id), "update" | "unchanged") = (row.employee_id, row.outcome) {
            *targets.entry(id).or_default() += 1;
        }
    }
    for row in &mut planned {
        if row
            .employee_id
            .is_some_and(|id| targets.get(&id).is_some_and(|n| *n > 1))
        {
            *row = refused(row.clone(), "duplicate_in_file", "employee_number");
        }
    }
    assign_numbers(&mut planned, decisions, facts.numbering);
    plan_group::apply(&mut planned, decisions);
    planned
}

fn plan_row(
    row: &ImportRow,
    twice: bool,
    facts: &PlanFacts<'_>,
    decisions: &Decisions,
) -> PlannedRow {
    let base = PlannedRow {
        source_key: row.source_key.clone(),
        sheet: row.sheet.clone(),
        row: row.row,
        name: row.name.clone(),
        outcome: "insert",
        employee_id: None,
        employee_number: row.employee_number.clone(),
        observed: None,
        diff: Vec::new(),
        deferred: Vec::new(),
        new_person: None,
        refusal_code: None,
        refusal_field: None,
        unit_name: None,
        workplace_name: None,
        candidates: Vec::new(),
        exclusion_code: None,
        matched_by: None,
    };
    if let Some(excluded) = decisions.exclusions.get(&row.source_key) {
        return PlannedRow {
            outcome: "excluded",
            exclusion_code: Some(excluded.reason_code.clone()),
            ..base
        };
    }
    if twice {
        return refused(base, "duplicate_in_file", "employee_number");
    }
    let mut dates = [None; 3];
    for (slot, (field, raw)) in dates.iter_mut().zip([
        ("hire_date", &row.hire_date),
        ("exit_date", &row.exit_date),
        ("birth_date", &row.birth_date),
    ]) {
        if let Some(raw) = raw {
            match parse_import_date(raw) {
                Some(date) => *slot = Some(date),
                None => return refused(base, "invalid_date", field),
            }
        }
    }
    let [hire, exit, birth] = dates;
    if birth.is_some_and(|birth| birth > facts.today) {
        return refused(base, "invalid_date", "birth_date");
    }
    if let Err((code, field)) = plan_status::status_of(row, decisions) {
        return refused(base, code, field);
    }
    let pick = decisions
        .identity
        .get(&row.source_key)
        .map(|pick| pick.employee_id);
    match identify(base.clone(), row, birth, facts, pick) {
        Identity::Known(person, how) => PlannedRow {
            matched_by: Some(how),
            ..existing(base, row, person, hire, birth, decisions, facts)
        },
        Identity::New => new_person(base, row, (hire, exit, birth), facts, decisions),
        Identity::Settled(planned) => *planned,
    }
}

fn new_person(
    base: PlannedRow,
    row: &ImportRow,
    (hire, exit, birth): (Option<time::Date>, Option<time::Date>, Option<time::Date>),
    facts: &PlanFacts<'_>,
    decisions: &Decisions,
) -> PlannedRow {
    let Some(hire) = hire else {
        return refused(base, "hire_date_required", "hire_date");
    };
    // r3:hire-16: the profile's dated ends, as typed dates or refused.
    let mut ends = [None, None];
    for (slot, (field, raw)) in ends.iter_mut().zip([
        ("contract_end_date", &row.contract_end_date),
        ("probation_end_date", &row.probation_end_date),
    ]) {
        if let Some(raw) = raw {
            match parse_import_date(raw) {
                Some(date) if date >= hire => *slot = Some(date.to_string()),
                _ => return refused(base, "invalid_date", field),
            }
        }
    }
    let [contract_end_date, probation_end_date] = ends;
    let (status, leave) = match plan_status::new_status(row, (hire, exit), facts, decisions) {
        Ok(status) => status,
        Err((code, field)) => return refused(base, code, field),
    };
    let (kind, unmapped) = plan_place::employment_type(row.employment_type.as_ref(), decisions);
    // A former employee keeps the unit text of the file and is bound to no
    // unit; r3:hire-22: the 사업장 of their 근무지 (or unit) is their 사업장 at
    // exit, so their 법인 is known (none when the two disagree: no guess).
    // A current one is bound and placed (MR-7).
    let mut left = false;
    let (org_unit, org_unit_id, unresolved, workplace, workplace_name) = if status == "EXITED" {
        let (unit, _) = plan_place::unit(row.org_unit.as_ref(), facts, decisions);
        let at_exit = plan_place::workplace(unit, row.worksite_name.as_ref(), facts, decisions)
            .ok()
            .and_then(|(workplace, _)| workplace)
            .filter(|w| {
                row.company.is_empty() && row.company_brn.is_none()
                    || facts
                        .company_workplaces
                        .get(&super::company_review::company_key(row))
                        .is_some_and(|places| places.contains(w))
            });
        (row.org_unit.clone(), None, None, at_exit, None)
    } else {
        let Ok(at) = plan_place::current_place(row, facts, decisions) else {
            return refused(base, "workplace_conflict", "worksite_name");
        };
        left = at.left;
        (
            row.org_unit.clone().filter(|_| at.unit.is_some()),
            at.unit,
            at.unresolved,
            at.workplace,
            at.named,
        )
    };
    PlannedRow {
        new_person: Some(NewPerson {
            employee_number: row.employee_number.clone(),
            employee_number_source: row.employee_number.as_ref().map(|_| "file"),
            status,
            hire_date: hire.to_string(),
            exit_date: exit.map(|d| d.to_string()),
            birth_date: birth.map(|d| d.to_string()),
            org_unit,
            org_unit_id,
            migrated_former: status == "EXITED",
            workplace_id: workplace,
            employment_type: kind,
            unresolved_org_unit: unresolved.clone(),
            leave,
            unplaced_reason: if left {
                Some("unit_left_unplaced")
            } else {
                (status != "EXITED")
                    .then(|| {
                        plan_place::unplaced_reason(row, org_unit_id, workplace, facts, decisions)
                    })
                    .flatten()
            },
            sex: row.sex.clone(),
            contract_end_date,
            probation_end_date,
        }),
        unit_name: if left { None } else { unresolved },
        workplace_name,
        deferred: unmapped.into_iter().collect(),
        ..base
    }
}

/// IMPORT-2: the 사번 of every new person, previewed: the file's own (refused
/// if someone holds or held it), the operator's, else the tenant rule's next
/// number — or none (「사번 미부여」) when the tenant keeps them for review.
fn assign_numbers(planned: &mut [PlannedRow], decisions: &Decisions, numbering: &Numbering) {
    let mut numbering = numbering.clone();
    for row in planned.iter_mut().filter(|row| row.outcome == "insert") {
        if let Some(number) = row
            .new_person
            .as_ref()
            .and_then(|p| p.employee_number.clone())
            && !numbering.taken.insert(number)
        {
            *row = refused(row.clone(), "employee_number_taken", "employee_number");
        }
    }
    for row in planned.iter_mut().filter(|row| row.outcome == "insert") {
        let manual = decisions.employee_numbers.get(&row.source_key).cloned();
        let Some(person) = row.new_person.as_mut() else {
            continue;
        };
        if person.employee_number.is_some() {
            continue;
        }
        let (number, source) = match manual {
            Some(number) if numbering.taken.insert(number.clone()) => (number, "manual"),
            Some(_) => {
                *row = refused(row.clone(), "employee_number_taken", "employee_number");
                continue;
            }
            None if numbering.assign => {
                let rule = numbering.rule_for(person.workplace_id);
                (numbering.next(&rule), "rule")
            }
            None => continue,
        };
        person.employee_number = Some(number.clone());
        person.employee_number_source = Some(source);
        row.employee_number = Some(number);
    }
}

#[cfg(test)]
#[path = "plan_tests.rs"]
mod tests;
