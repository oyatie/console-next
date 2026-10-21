//! `insurance_loss_codes` rows: the 고용보험, 국민연금 and 건강보험 상실 codes.

use console_kernel_core::KernelError;
use serde::{Deserialize, Serialize};
use time::Date;

use super::{Citation, ReleaseDisposition};

/// Which insurer a 상실 code belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Insurer {
    /// 고용보험
    Ei,
    /// 국민연금
    Nps,
    /// 건강보험
    Nhis,
}

impl Insurer {
    pub fn from_db_str(value: &str) -> Result<Self, KernelError> {
        match value {
            "EI" => Ok(Self::Ei),
            "NPS" => Ok(Self::Nps),
            "NHIS" => Ok(Self::Nhis),
            other => Err(KernelError::validation(format!(
                "unknown insurer {other:?}"
            ))),
        }
    }
}

/// How a 상실 reason is classed; drives evidence and blind re-entry controls.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LossReasonGroup {
    Voluntary,
    Involuntary,
    InvoluntaryFault,
    TermEnd,
    Other,
}

impl LossReasonGroup {
    pub fn from_db_str(value: &str) -> Result<Self, KernelError> {
        Ok(match value {
            "VOLUNTARY" => Self::Voluntary,
            "INVOLUNTARY" => Self::Involuntary,
            "INVOLUNTARY_FAULT" => Self::InvoluntaryFault,
            "TERM_END" => Self::TermEnd,
            "OTHER" => Self::Other,
            other => {
                return Err(KernelError::validation(format!(
                    "unknown loss reason group {other:?}"
                )));
            }
        })
    }
}

/// One `insurance_loss_codes` row. Its `effective_from` is the code-table
/// version an exit payload records.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InsuranceLossCode {
    pub insurer: Insurer,
    pub code: String,
    pub label_ko: String,
    pub group: LossReasonGroup,
    pub requires_detail: bool,
    pub effective_from: Date,
    pub effective_to_exclusive: Option<Date>,
    pub citation: Citation,
    pub disposition: ReleaseDisposition,
}
