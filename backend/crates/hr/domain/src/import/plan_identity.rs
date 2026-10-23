//! IMPORT-2 (decisions #25) who a row is, in order: the operator's pick, the
//! 사번 (current, then an alias of an earlier 사번); RRN and namesakes
//! are review evidence, never automatic identity keys.
//! A 사번 and an RRN that name two different people are a conflict for the
//! operator, not a merge.

use super::plan::{Candidate, ImportRow, OnFile, PlanFacts, PlannedRow};
use super::plan_people::unresolved;
use super::plan_rows::refused;

/// What the planner does with a row's identity.
pub(super) enum Identity<'a> {
    /// The person on file, and how they were found.
    Known(&'a OnFile, &'static str),
    New,
    /// A finished plan row (waiting or refused).
    Settled(Box<PlannedRow>),
}

/// A person a row may be, with what tells namesakes apart (동명이인).
pub(super) fn candidate(person: &OnFile, basis: &'static str) -> Candidate {
    Candidate {
        employee_id: person.id,
        employee_number: person.employee_number.clone(),
        status: person.status.clone(),
        basis,
        company: person.company.clone(),
        org_unit: person.org_unit.clone(),
        birth_date_masked: person
            .birth_date
            .map(|d| format!("{}-{:02}-**", d.year(), u8::from(d.month()))),
    }
}

pub(super) fn identify<'a>(
    base: PlannedRow,
    row: &ImportRow,
    birth: Option<time::Date>,
    facts: &PlanFacts<'a>,
    pick: Option<Option<uuid::Uuid>>,
) -> Identity<'a> {
    let people = facts.people;
    if let Some(pick) = pick {
        return match pick {
            Some(id) => match people.iter().find(|p| p.id == id) {
                Some(person) => Identity::Known(person, "pick"),
                None => Identity::Settled(Box::new(unresolved(base, row, birth, facts))),
            },
            None => match row.employee_number.as_deref() {
                Some(number) if people.iter().any(|p| holds(p, number)) => Identity::Settled(
                    Box::new(refused(base, "identity_conflict", "employee_number")),
                ),
                _ => Identity::New,
            },
        };
    }
    let by_number = row.employee_number.as_deref().and_then(|number| {
        people
            .iter()
            .find(|p| p.employee_number.as_deref() == Some(number))
            .map(|p| (p, "employee_number"))
            .or_else(|| {
                people
                    .iter()
                    .find(|p| p.aliases.iter().any(|a| a == number))
                    .map(|p| (p, "alias"))
            })
    });
    let by_rrn: Vec<&OnFile> = row.rrn_hmac.as_ref().map_or_else(Vec::new, |hash| {
        people
            .iter()
            .filter(|p| p.rrn_hmac.as_ref() == Some(hash))
            .collect()
    });
    match (by_number, by_rrn.as_slice()) {
        (Some((person, how)), others) if others.iter().all(|o| o.id == person.id) => {
            Identity::Known(person, how)
        }
        (Some(_), others) => Identity::Settled(Box::new(PlannedRow {
            candidates: others.iter().map(|p| candidate(p, "rrn")).collect(),
            ..refused(base, "identity_conflict", "rrn")
        })),
        (None, []) if row.employee_number.is_some() => Identity::New,
        (None, []) => {
            let waiting = unresolved(base, row, birth, facts);
            if waiting.candidates.is_empty() {
                Identity::New
            } else {
                Identity::Settled(Box::new(waiting))
            }
        }
        (None, many) => Identity::Settled(Box::new(PlannedRow {
            outcome: "unresolved_identity",
            candidates: many.iter().map(|p| candidate(p, "rrn")).collect(),
            ..base
        })),
    }
}

fn holds(person: &OnFile, number: &str) -> bool {
    person.employee_number.as_deref() == Some(number) || person.aliases.iter().any(|a| a == number)
}
