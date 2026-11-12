//! MR-35 restricted sections: disability and veteran status. Disability is
//! health information, sensitive information under Personal Information
//! Protection Act §23①, which may be processed only with a separate consent
//! (§23①1) or where a statute requires or permits it (§23①2). Every revision
//! therefore carries its [`Basis`]. Fields are what employment duties read and
//! no more: disability severity (Disabled Persons Employment Promotion Act §2
//! item 2, §28-3: severe counts twice), veteran target (Act on Persons of
//! Distinguished Service to the State §29 persons eligible for employment
//! support). No disability type, no service-injury grade.

use console_kernel_core::KernelError;
use serde::{Deserialize, Serialize};
use time::Date;

use super::{code_enum, iso_date};

code_enum!(DisabilitySeverity { Severe => "SEVERE", NonSevere => "NON_SEVERE" });
code_enum!(VeteranTarget { SelfHolder => "SELF", Family => "FAMILY" });
code_enum!(
    /// The statute a §23①2 basis relies on: DISABLED_EMPLOYMENT = Disabled
    /// Persons Employment Promotion Act §28①, §29①, §33①⑤; VETERAN_EMPLOYMENT
    /// = Act on Persons of Distinguished Service to the State §30 item 2,
    /// §33-2①, §34. [J] Whether it covers a given employer is counsel's
    /// reading; the code only names what HR relied on.
    BasisStatute {
        DisabledEmployment => "DISABLED_EMPLOYMENT",
        VeteranEmployment => "VETERAN_EMPLOYMENT",
    }
);

/// Why a restricted entry may be processed (Personal Information Protection Act §23①).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "SCREAMING_SNAKE_CASE", deny_unknown_fields)]
pub enum Basis {
    /// §23①1: the subject's separate consent, given on `consent_on`.
    Consent {
        #[serde(with = "iso_date")]
        consent_on: Date,
    },
    /// §23①2: a statute that requires or permits the processing.
    Statute { statute: BasisStatute },
}

impl Basis {
    pub(crate) fn check(self, allowed: BasisStatute) -> Result<Self, KernelError> {
        match self {
            Self::Statute { statute } if statute != allowed => Err(KernelError::validation(
                "basis statute does not cover this section",
            )),
            other => Ok(other),
        }
    }
}

/// Disability.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Disability {
    pub severity: DisabilitySeverity,
    #[serde(default, with = "iso_date::option")]
    pub recognised_on: Option<Date>,
    pub basis: Basis,
}

/// Veteran status (persons eligible for employment support). [J] Not a §23①
/// category itself; restricted because it can reveal a service injury.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Veteran {
    pub target: VeteranTarget,
    #[serde(default, with = "iso_date::option")]
    pub recognised_on: Option<Date>,
    pub basis: Basis,
}

impl Disability {
    pub(crate) fn validate(self) -> Result<Self, KernelError> {
        Ok(Self {
            basis: self.basis.check(BasisStatute::DisabledEmployment)?,
            ..self
        })
    }
}

impl Veteran {
    pub(crate) fn validate(self) -> Result<Self, KernelError> {
        Ok(Self {
            basis: self.basis.check(BasisStatute::VeteranEmployment)?,
            ..self
        })
    }
}
