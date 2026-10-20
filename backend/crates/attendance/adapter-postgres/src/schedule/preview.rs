//! Scope membership, caller reach and the assignment preview. Pure over a
//! loaded universe and roster, so the preview and the commit decide alike.

use std::collections::BTreeMap;

use console_attendance_application::CallerScope;
use console_attendance_application::schedule::{AssignInput, Kept, Refusal, SchedulePreview};
use console_attendance_domain::schedule::{
    AssignRules, LayerReason, LayerRef, Level, PatternSpec, check_assign, winner,
};
use time::Date;
use uuid::Uuid;

use super::org::Person;
use super::universe::Universe;
use super::{ScheduleStoreError, codes, month_label};

/// Does `p` belong to the scope, and at which 부서 depth.
pub(crate) fn reach(u: &Universe, p: &Person, level: Level, id: Uuid) -> Option<u8> {
    match level {
        Level::Person => (p.id == id).then_some(0),
        Level::Crew => (p.crew == Some(id)).then_some(0),
        Level::Department => p.unit.and_then(|unit| {
            u.org
                .chain(unit)
                .into_iter()
                .find(|(x, _)| *x == id)
                .map(|(_, d)| d)
        }),
        Level::Workplace => (p.workplace_id == Some(id)).then_some(0),
        Level::LegalEntity => (p.legal_entity_id == Some(id)).then_some(0),
    }
}

/// The branch a person is scoped by (their 사업장's).
pub(crate) fn branch_of(u: &Universe, p: &Person) -> Option<Uuid> {
    p.workplace_id
        .and_then(|w| u.org.workplaces.get(&w))
        .and_then(|w| w.branch_id)
}

pub(crate) fn visible(caller: &CallerScope, u: &Universe, p: &Person) -> bool {
    caller.org_wide || caller.permits_branch(branch_of(u, p))
}

/// Whether the caller may write at this scope; the scope must exist.
///
/// # Errors
/// `scope_not_found` (404) or `Forbidden`.
pub(crate) fn authorize_scope(
    caller: &CallerScope,
    u: &Universe,
    roster: &[Person],
    level: Level,
    id: Uuid,
) -> Result<Option<Uuid>, ScheduleStoreError> {
    let missing = ScheduleStoreError::NotFound(codes::SCOPE_NOT_FOUND);
    let workplace = match level {
        Level::LegalEntity => {
            if !u.org.entities.contains_key(&id) {
                return Err(missing);
            }
            return if caller.org_wide {
                Ok(None)
            } else {
                Err(ScheduleStoreError::Forbidden)
            };
        }
        Level::Workplace => u.org.workplaces.contains_key(&id).then_some(id),
        Level::Department => u
            .org
            .units
            .contains_key(&id)
            .then(|| u.org.workplace_of_unit(id))
            .flatten(),
        Level::Crew => u.org.crews.get(&id).map(|(w, _)| *w),
        Level::Person => roster
            .iter()
            .find(|p| p.id == id)
            .and_then(|p| p.workplace_id),
    }
    .ok_or(missing)?;
    let branch = u.org.workplaces.get(&workplace).and_then(|w| w.branch_id);
    if caller.org_wide || caller.permits_branch(branch) {
        Ok(branch)
    } else {
        Err(ScheduleStoreError::Forbidden)
    }
}

pub(crate) fn preview(
    caller: &CallerScope,
    u: &Universe,
    roster: &[Person],
    input: &AssignInput,
    today: Date,
    closed: &[(i32, u8)],
) -> Result<SchedulePreview, ScheduleStoreError> {
    let pattern = u
        .patterns
        .get(&input.pattern_id)
        .ok_or(ScheduleStoreError::NotFound(codes::PATTERN_NOT_FOUND))?;
    let derived = pattern
        .spec
        .pattern
        .validate(today, &u.floors)
        .map_err(ScheduleStoreError::Refused)?;
    let reason = LayerReason::parse(&input.reason)
        .ok_or(ScheduleStoreError::Invalid(codes::REASON_INVALID))?;
    let choices = match &pattern.spec.pattern {
        PatternSpec::Staggered { start_choices, .. } => Some(start_choices.as_slice()),
        _ => None,
    };
    let mut refusals = Vec::new();
    for (i, t) in input.targets.iter().enumerate() {
        authorize_scope(caller, u, roster, t.scope_kind, t.scope_id)?;
        let rules = AssignRules {
            effective_from: input.effective_from,
            effective_to: input.effective_to,
            reason,
            evidence_ref: input.evidence_ref.as_deref(),
            person_scope: t.scope_kind == Level::Person,
            pattern_active: pattern.active,
            start_choices: choices,
            start_choice: t.start_choice,
            closed_months: closed,
        };
        if let Err(r) = check_assign(&rules) {
            refusals.push(Refusal {
                code: r.code(),
                target: Some(i),
            });
        }
    }
    let first = (
        input.effective_from.year(),
        u8::from(input.effective_from.month()),
    );
    let closed_months = closed
        .iter()
        .filter(|m| **m >= first)
        .map(|m| month_label(*m))
        .collect();
    let mut tally = Tally::default();
    for p in roster.iter().filter(|p| visible(caller, u, p)) {
        let mut refs = u.layers_for(p);
        let before = refs.len();
        for (i, t) in input.targets.iter().enumerate() {
            if let Some(depth) = reach(u, p, t.scope_kind, t.scope_id) {
                refs.push(LayerRef {
                    id: Uuid::from_u128(u128::MAX - i as u128),
                    level: t.scope_kind,
                    depth,
                    pattern_id: input.pattern_id,
                    effective_from: input.effective_from,
                    effective_to: input.effective_to,
                    version: i32::MAX,
                    rotation_start: t.rotation_start,
                    start_choice: t.start_choice,
                });
            }
        }
        tally.add(refs.len() > before, winner(&refs, input.effective_from));
    }
    Ok(SchedulePreview {
        people_in_scope: tally.in_scope,
        people_changed: tally.changed,
        kept: tally
            .kept
            .into_iter()
            .map(|(level, people)| Kept { level, people })
            .collect(),
        closed_months,
        past_from: input.effective_from < today,
        night_work: derived.night_work,
        weekly_minutes: i32::try_from(derived.weekly_minutes).unwrap_or(i32::MAX),
        unscheduled_after: tally.unscheduled,
        refusals,
    })
}

#[derive(Default)]
struct Tally {
    in_scope: i64,
    changed: i64,
    unscheduled: i64,
    kept: BTreeMap<Level, i64>,
}

impl Tally {
    fn add(&mut self, reached: bool, w: Option<&LayerRef>) {
        match w {
            None => self.unscheduled += 1,
            Some(w) if reached => {
                self.in_scope += 1;
                // The stand-in version marks a new layer.
                if w.version == i32::MAX {
                    self.changed += 1;
                } else {
                    *self.kept.entry(w.level).or_default() += 1;
                }
            }
            Some(_) => {}
        }
    }
}
