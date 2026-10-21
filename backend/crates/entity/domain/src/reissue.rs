//! 등록증 재발급·정정 against the record's recorded states. Revisions are
//! full states, so a change dated before a later one is hidden or undone by
//! it: such a date is refused, never written. Pure; the adapter reads the dates.

use crate::refusal::{Refusal, Warning};

/// A reissue dated before the registration state in force: its row sorts
/// under that state and never shows, while its certificate becomes the one
/// in force (that is an error correction, from the date in force).
pub const BEFORE_STATE_IN_FORCE: &str = "before_state_in_force";
/// A reissue dated before a scheduled registration state: that state, recorded
/// without the change, would undo it from its day on.
pub const REGISTRATION_CHANGE_SCHEDULED: &str = "registration_change_scheduled";
/// The same for the 법인's part (대표자, 법인명, 본점) and a scheduled 법인 state.
pub const ENTITY_CHANGE_SCHEDULED: &str = "entity_change_scheduled";
/// The 법인's part was moved to the later state's date (that state is in force).
pub const ENTITY_CHANGE_FROM_LATER_STATE: &str = "entity_change_from_later_state";

/// The registration's recorded states against the reissue's date: the state in
/// force from `in_force` (the latest on or before today) and the latest of all
/// (`latest`, after today when one is scheduled). Full-state revisions: a
/// change dated before either would be hidden or undone by it.
///
/// # Errors
/// `effective_from` `before_state_in_force` or `registration_change_scheduled`.
pub fn reissue_registration_from(
    from: time::Date,
    in_force: Option<time::Date>,
    latest: Option<time::Date>,
    today: time::Date,
) -> Result<(), Refusal> {
    if in_force.is_some_and(|d| from < d) {
        return Err(Refusal::field("effective_from", BEFORE_STATE_IN_FORCE));
    }
    if latest.is_some_and(|d| d > today && from < d) {
        return Err(Refusal::field(
            "effective_from",
            REGISTRATION_CHANGE_SCHEDULED,
        ));
    }
    Ok(())
}

/// From when the reissue's 법인 part holds, given the 법인's latest recorded
/// state (`latest`). The part is the state in force with the certificate's
/// changes, so a scheduled state (not in it) is refused rather than undone; a
/// later state already in force is that state, so the part starts there, with
/// a warning (ponytail: carrying the change through later states,
/// ent-revision-carry-forward, keeps its own date).
///
/// # Errors
/// `effective_from` `entity_change_scheduled`.
pub fn reissue_entity_from(
    from: time::Date,
    latest: Option<time::Date>,
    today: time::Date,
) -> Result<(time::Date, Option<Warning>), Refusal> {
    match latest {
        Some(l) if l > today => Err(Refusal::field("effective_from", ENTITY_CHANGE_SCHEDULED)),
        Some(l) if l > from => Ok((
            l,
            Some(Warning {
                field: "effective_from".into(),
                code: ENTITY_CHANGE_FROM_LATER_STATE,
            }),
        )),
        _ => Ok((from, None)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::date;

    fn fields(r: Refusal) -> Vec<(String, &'static str)> {
        r.fields.into_iter().map(|f| (f.field, f.code)).collect()
    }

    #[test]
    fn a_reissue_is_never_dated_under_a_registration_state_in_force_or_scheduled() {
        let today = date!(2026 - 10 - 15);
        let code = |from, in_force, latest| {
            reissue_registration_from(from, in_force, latest, today)
                .err()
                .map(|r| fields(r)[0].1)
        };
        let (sep, oct, nov) = (
            date!(2026 - 09 - 01),
            date!(2026 - 10 - 01),
            date!(2026 - 11 - 14),
        );
        assert_eq!(code(oct, Some(sep), Some(sep)), None);
        assert_eq!(
            code(oct, Some(oct), Some(oct)),
            None,
            "the day in force: a correction of it"
        );
        assert_eq!(code(sep, Some(oct), Some(oct)), Some(BEFORE_STATE_IN_FORCE));
        assert_eq!(
            code(oct, Some(sep), Some(nov)),
            Some(REGISTRATION_CHANGE_SCHEDULED)
        );
        assert_eq!(code(oct, None, None), None);
    }

    #[test]
    fn the_entity_part_is_refused_under_a_scheduled_state_and_moved_to_one_in_force() {
        let today = date!(2026 - 10 - 15);
        let from = date!(2026 - 10 - 01);
        assert_eq!(
            reissue_entity_from(from, None, today).unwrap(),
            (from, None)
        );
        assert_eq!(
            reissue_entity_from(from, Some(date!(2026 - 09 - 01)), today).unwrap(),
            (from, None)
        );
        let (moved, w) = reissue_entity_from(from, Some(today), today).unwrap();
        assert_eq!(
            (moved, w.unwrap().code),
            (today, ENTITY_CHANGE_FROM_LATER_STATE)
        );
        let r = reissue_entity_from(from, Some(date!(2026 - 11 - 14)), today).unwrap_err();
        assert_eq!(
            fields(r),
            vec![("effective_from".to_owned(), ENTITY_CHANGE_SCHEDULED)]
        );
    }
}
