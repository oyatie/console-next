//! 근태 기록 persistence (ATT S2): the day board, the month grid, one
//! person's month, and the batch writes (save, 정정, 기록 취소, 일괄 취소).
//! Errors share `ScheduleStoreError` and its codes.

mod board;
mod board_issues;
mod board_page;
mod cells;
mod day;
mod edits;
pub(crate) mod entries;
mod grid;
pub(crate) mod roster;
mod save;
mod thresholds;

pub use board::{BoardAccessFuture, BoardQuery, BoardReadAccess, BoardReadTarget};
pub use grid::GridQuery;

pub const RECORDS_PAGE_LIMIT: usize = 200;

/// Explicit filters are resources and resolve to the board's workplace boundary.
pub(crate) fn authorize_filters(
    universe: &crate::schedule::universe::Universe,
    workplace: Option<uuid::Uuid>,
    unit: Option<uuid::Uuid>,
    access: &BoardReadAccess,
) -> Result<(), crate::schedule::ScheduleStoreError> {
    use console_attendance_domain::schedule::Level;
    for (kind, id) in [(Level::Workplace, workplace), (Level::Department, unit)] {
        if let Some(id) = id {
            let workplace = match kind {
                Level::Workplace => universe.org.workplaces.contains_key(&id).then_some(id),
                Level::Department => universe.org.workplace_of_unit(id),
                _ => None,
            }
            .ok_or(crate::schedule::ScheduleStoreError::NotFound(
                crate::schedule::codes::SCOPE_NOT_FOUND,
            ))?;
            if !access(BoardReadTarget::Scope(Level::Workplace, workplace))? {
                return Err(crate::schedule::ScheduleStoreError::Forbidden);
            }
        }
    }
    Ok(())
}
