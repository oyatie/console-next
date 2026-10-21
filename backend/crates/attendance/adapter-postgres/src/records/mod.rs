//! 근태 기록 persistence (ATT S2): the day board, the month grid, one
//! person's month, and the batch writes (save, 정정, 기록 취소, 일괄 취소).
//! Errors share `ScheduleStoreError` and its codes.

mod board;
mod cells;
mod day;
mod edits;
mod entries;
mod grid;
mod roster;
mod save;
mod thresholds;

pub use board::BoardQuery;
pub use grid::GridQuery;

/// Explicit filters are resources, so absence and branch reach use the schedule's authorizer.
pub(crate) fn authorize_filters(
    caller: &console_attendance_application::CallerScope,
    universe: &crate::schedule::universe::Universe,
    workplace: Option<uuid::Uuid>,
    unit: Option<uuid::Uuid>,
) -> Result<(), crate::schedule::ScheduleStoreError> {
    use console_attendance_domain::schedule::Level;
    for (kind, id) in [(Level::Workplace, workplace), (Level::Department, unit)] {
        if let Some(id) = id {
            crate::schedule::preview::authorize_scope(caller, universe, &[], kind, id)?;
        }
    }
    Ok(())
}
