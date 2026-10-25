//! Lifecycle trail: LC-B4 reads and completion, LC-B5 templates, LC-B6 transactional openers.

mod access;
mod attest;
mod clock_tick;
pub(crate) mod dates;
mod hire_facts;
pub(crate) mod open;
mod preview;
mod read;
pub(crate) mod register;
mod types;
mod window;
mod write;
pub use types::*;

pub(super) fn refused(code: &'static str) -> crate::HrError {
    crate::HrError {
        errors: None,
        status: http::StatusCode::CONFLICT,
        code,
        message: code.to_owned(),
        refusals: None,
    }
}

mod applicability;
pub(crate) mod group_transfer;
pub(crate) mod observe;
