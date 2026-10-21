//! Lifecycle cases (lifecycle-events.md §5; migration 0314). LC-B3 ships the
//! worker's daily clock tick only; the API is LC-B4 and the openers LC-B6.

mod clock_tick;
pub(crate) mod register;
