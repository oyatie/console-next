//! EMP-MODEL facts (parity E3, E4, E5, E12/F5, E13): the facts record, its
//! field PATCH and the 수습 종료 confirmation.

mod min_wage;
mod patch;
mod probation;
mod read;

pub use min_wage::{MinimumWageHint, MinimumWageInstrument, MinimumWageQuery, minimum_wage_hint};
pub use probation::ConfirmProbationRequest;
pub use read::{EmploymentFacts, EmploymentProfileFacts};
pub(crate) use read::{date_text, load_facts};
