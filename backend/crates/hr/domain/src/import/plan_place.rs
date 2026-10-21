//! MR-7: what an imported row records beyond the person itself: the unit
//! (or 미배치), the 사업장 the person is placed at, and the 고용형태 of the
//! employment profile. Never a refusal for a value nobody answered: the
//! field stays empty and the plan row says why.

use uuid::Uuid;

use super::normalize::employment_type_code;
use super::plan::{Decisions, Deferred, ImportRow, PlanFacts};

/// The unit a current person is bound to, and the file's unit name when it
/// resolves to none (the operator's 미배치, an unknown or an ambiguous name).
pub(super) fn unit(
    name: Option<&String>,
    facts: &PlanFacts<'_>,
    decisions: &Decisions,
) -> (Option<Uuid>, Option<String>) {
    let Some(name) = name else {
        return (None, None);
    };
    let id = match decisions.unit_map.get(name) {
        Some(answer) => *answer,
        None => facts
            .units
            .get(name)
            .and_then(|ids| (ids.len() == 1).then(|| ids[0])),
    };
    (id, id.is_none().then(|| name.clone()))
}

/// The 사업장 of a current person: the one the unit sits in, else the one the
/// 사업장 text names (the operator's answer, else the one open 사업장 of that
/// exact name). `Err` when the two disagree; the second value is the text
/// when it named no 사업장.
pub(super) fn workplace(
    unit: Option<Uuid>,
    text: Option<&String>,
    facts: &PlanFacts<'_>,
    decisions: &Decisions,
) -> Result<(Option<Uuid>, Option<String>), ()> {
    let at_unit = unit.and_then(|unit| facts.unit_workplaces.get(&unit).copied());
    let named = text.and_then(|value| match decisions.workplace_map.get(value) {
        Some(answer) => *answer,
        None => facts
            .workplaces
            .get(value)
            .and_then(|ids| (ids.len() == 1).then(|| ids[0])),
    });
    if let (Some(a), Some(b)) = (at_unit, named)
        && a != b
    {
        return Err(());
    }
    let unnamed = text
        .filter(|value| named.is_none() && !decisions.workplace_map.contains_key(*value))
        .cloned();
    Ok((at_unit.or(named), unnamed))
}

/// A current person's place: the 부서 (if it binds), the 사업장 and the
/// 근무지 text that bound none; `Err` when the 부서's 사업장 is not the
/// 근무지's and no group answer says which one wins (r3:hire-19).
pub(super) fn current_place(
    row: &ImportRow,
    facts: &PlanFacts<'_>,
    decisions: &Decisions,
) -> Result<Place, ()> {
    let key = super::company_review::company_key(row);
    let company = decisions.company_map.get(&key).copied().flatten();
    if (!row.company.is_empty() || row.company_brn.is_some()) && company.is_none() {
        return Ok(Place {
            unit: None,
            unresolved: row.org_unit.clone(),
            workplace: None,
            named: row.worksite_name.clone(),
            left: false,
        });
    }
    let (unit, unresolved) = unit(row.org_unit.as_ref(), facts, decisions);
    let text = row.worksite_name.as_ref();
    let company_places = facts.company_workplaces.get(&key);
    let place = match workplace(unit, text, facts, decisions) {
        Ok((at, named)) => Place {
            unit,
            unresolved,
            workplace: at.or(company.filter(|_| row.org_unit.is_none() && text.is_none())),
            named,
            left: false,
        },
        Err(()) => match decisions
            .group_answers
            .get("workplace_conflict")
            .map(String::as_str)
        {
            Some("follow_unit") => {
                let at = unit.and_then(|u| facts.unit_workplaces.get(&u).copied());
                Place {
                    unit,
                    unresolved,
                    workplace: at,
                    named: None,
                    left: false,
                }
            }
            Some("follow_workplace") => {
                let (at, named) = workplace(None, text, facts, decisions)?;
                Place {
                    unit: None,
                    unresolved: row.org_unit.clone(),
                    workplace: at,
                    named,
                    left: true,
                }
            }
            _ => return Err(()),
        },
    };
    if company.is_some()
        && place
            .workplace
            .is_some_and(|w| company_places.is_none_or(|places| !places.contains(&w)))
    {
        return Err(());
    }
    Ok(place)
}

/// Where [`current_place`] puts a person; `left`: the 부서 is left 미배치 by
/// the operator's group answer.
pub(super) struct Place {
    pub unit: Option<Uuid>,
    pub unresolved: Option<String>,
    pub workplace: Option<Uuid>,
    pub named: Option<String>,
    pub left: bool,
}

/// W03: why a current person comes in 미배치, counted by the dry run. A
/// person with no 부서 text at a 사업장 is placed (사업장 직속).
pub(super) fn unplaced_reason(
    row: &ImportRow,
    unit: Option<Uuid>,
    workplace: Option<Uuid>,
    facts: &PlanFacts<'_>,
    decisions: &Decisions,
) -> Option<&'static str> {
    if unit.is_some() {
        return workplace.is_none().then_some("workplace_unknown");
    }
    let Some(name) = &row.org_unit else {
        return workplace.is_none().then_some("no_place");
    };
    Some(match decisions.unit_map.get(name) {
        Some(None) => "unit_left_unplaced",
        _ if facts.units.get(name).is_some_and(|ids| ids.len() > 1) => "unit_ambiguous",
        _ => "unit_unknown",
    })
}

/// The 고용형태 code of the row: the operator's answer, else the code or a
/// label with one meaning (W02, reported as `auto_mapped`). A label nobody
/// mapped stays empty and comes back deferred (`value_map`), which the review
/// queue makes a blocking question.
pub(super) fn employment_type(
    text: Option<&String>,
    decisions: &Decisions,
) -> (Option<String>, Option<Deferred>) {
    let Some(value) = text else {
        return (None, None);
    };
    if let Some(answer) = decisions.employment_type_map.get(value) {
        return (answer.clone(), None);
    }
    match employment_type_code(value) {
        Some(code) => (Some(code.to_owned()), None),
        None => (
            None,
            Some(Deferred {
                field: "employment_type",
                from: None,
                to: Some(value.clone()),
                route: "value_map",
            }),
        ),
    }
}
