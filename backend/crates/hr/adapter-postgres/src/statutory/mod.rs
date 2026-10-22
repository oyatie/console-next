//! The MVP statutory panel: worker register and manual insurance filing records.
mod filing_placement;
mod filing_query;
mod filing_read;
mod filing_request;
mod filing_validation;
mod filing_write;
pub use filing_request::{RequestFiling, RequestKind};
mod filings;
mod register;
mod register_export;
mod types;
mod workplaces;
pub use filing_validation::RecordFiling;
pub use register::{RegisterPage, RegisterQuery};
pub use register_export::RegisterExport;
pub use types::{FilingPage, FilingQuery, FilingTask};
pub use workplaces::RegisterWorkplace;

use crate::HrError;
use http::StatusCode;

pub(super) fn refusal(status: StatusCode, code: &'static str, message: &str) -> HrError {
    HrError {
        errors: None,
        status,
        code,
        message: message.to_owned(),
        refusals: None,
    }
}
