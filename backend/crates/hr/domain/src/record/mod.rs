//! Personnel card sections. MR-31: education, qualifications and licenses,
//! military service, training completed — the "other matters (education,
//! military service, skills and qualifications, training completed, etc. as
//! needed)" of Labor Standards Act Enforcement Rule Annex Form No. 16. MR-33:
//! language, awards, disciplinary action, family. MR-35: disability, veteran
//! status (restricted, with a Personal Information Protection Act §23① basis).
//! An entry is a fact of the natural person; every change is a new revision
//! (CREATE, UPDATE = correction, VOID).
//!
//! Pure rules only: the field shapes and their checks, and the import-sheet
//! row decision. PII minimisation is structural: there is no field for an
//! exemption reason, a discharge type or a driver's license number (Personal
//! Information Protection Act §23, §24, Enforcement Decree §19).

mod fields;
mod fields_company;
mod fields_restricted;
mod guard;
pub mod plan;

pub use fields::{
    EduLevel, EduStatus, Education, MilBranch, MilStatus, Military, QualKind, Qualification,
    TrainStatus, Training,
};
pub use fields_company::{Award, Discipline, Family, FamilyRelation, Language};
pub use fields_restricted::{
    Basis, BasisStatute, Disability, DisabilitySeverity, Veteran, VeteranTarget,
};
pub use guard::looks_like_identifier_number;

use console_kernel_core::KernelError;
use serde::Serialize;

time::serde::format_description!(iso_date, Date, "[year]-[month]-[day]");

/// Defines a closed code list: serde as the code, `as_str` for SQL, `parse`
/// for a stored value (an unknown stored code is an internal error).
macro_rules! code_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $code:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
        pub enum $name { $(#[serde(rename = $code)] $variant,)+ }

        impl $name {
            pub const ALL: &'static [Self] = &[$(Self::$variant,)+];

            #[must_use]
            pub const fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $code,)+ }
            }

            /// # Errors
            /// Internal when a stored value is not one of the codes.
            pub fn parse(value: &str) -> Result<Self, console_kernel_core::KernelError> {
                match value {
                    $($code => Ok(Self::$variant),)+
                    _ => Err(console_kernel_core::KernelError::internal(
                        concat!("stored ", stringify!($name), " is not a known code"),
                    )),
                }
            }
        }
    };
}
pub(crate) use code_enum;

code_enum!(
    /// MR-31's four, MR-33's four (rewards and discipline is awards +
    /// disciplinary action) and MR-35's two.
    Section {
        Education => "EDUCATION",
        Qualification => "QUALIFICATION",
        Military => "MILITARY",
        Training => "TRAINING",
        Language => "LANGUAGE",
        Award => "AWARD",
        Discipline => "DISCIPLINE",
        Family => "FAMILY",
        Disability => "DISABILITY",
        Veteran => "VETERAN",
    }
);

impl Section {
    /// The route segment: `/employees/{id}/records/{segment}`.
    #[must_use]
    pub const fn segment(self) -> &'static str {
        match self {
            Self::Education => "education",
            Self::Qualification => "qualification",
            Self::Military => "military",
            Self::Training => "training",
            Self::Language => "language",
            Self::Award => "award",
            Self::Discipline => "discipline",
            Self::Family => "family",
            Self::Disability => "disability",
            Self::Veteran => "veteran",
        }
    }

    /// # Errors
    /// Not found for an unknown segment, so a typo reads as a missing route.
    pub fn from_segment(value: &str) -> Result<Self, KernelError> {
        Self::ALL
            .iter()
            .copied()
            .find(|s| s.segment() == value)
            .ok_or_else(|| KernelError::not_found("unknown record section"))
    }

    /// Military service, disability and veteran status are one status per
    /// person: a second live entry is refused and an import row without an entry
    /// id corrects the live one.
    #[must_use]
    pub const fn single_live(self) -> bool {
        matches!(self, Self::Military | Self::Disability | Self::Veteran)
    }

    /// Restricted: left out of the plain personnel card read, read only with a
    /// purpose (audited), never exported as a sheet, and gated by the
    /// `employee_restricted_record` Cedar action. Disability and veteran status
    /// are sensitive information (§23①); disciplinary action is held back for
    /// the discipline domain the access model reserves.
    ///
    /// Disciplinary action rides this gate until the access model's discipline
    /// domain mounts; move it to that domain's grant then.
    #[must_use]
    pub const fn restricted(self) -> bool {
        matches!(self, Self::Discipline | Self::Disability | Self::Veteran)
    }
}

code_enum!(RevisionKind { Create => "CREATE", Update => "UPDATE", Void => "VOID" });
code_enum!(RecordSource { Manual => "MANUAL", Import => "IMPORT" });

/// One entry's values, typed per section. Serialises as the inner object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum RecordFields {
    Education(Education),
    Qualification(Qualification),
    Military(Military),
    Training(Training),
    Language(Language),
    Award(Award),
    Discipline(Discipline),
    Family(Family),
    Disability(Disability),
    Veteran(Veteran),
}

impl RecordFields {
    #[must_use]
    pub const fn section(&self) -> Section {
        match self {
            Self::Education(_) => Section::Education,
            Self::Qualification(_) => Section::Qualification,
            Self::Military(_) => Section::Military,
            Self::Training(_) => Section::Training,
            Self::Language(_) => Section::Language,
            Self::Award(_) => Section::Award,
            Self::Discipline(_) => Section::Discipline,
            Self::Family(_) => Section::Family,
            Self::Disability(_) => Section::Disability,
            Self::Veteran(_) => Section::Veteran,
        }
    }

    /// Normalise (trim, empty optional text → none, month precision) and
    /// check every rule. The adapter stores only what this returns.
    ///
    /// # Errors
    /// Validation naming the first field that breaks a rule.
    pub fn validate(self) -> Result<Self, KernelError> {
        Ok(match self {
            Self::Education(v) => Self::Education(v.validate()?),
            Self::Qualification(v) => Self::Qualification(v.validate()?),
            Self::Military(v) => Self::Military(v.validate()?),
            Self::Training(v) => Self::Training(v.validate()?),
            Self::Language(v) => Self::Language(v.validate()?),
            Self::Award(v) => Self::Award(v.validate()?),
            Self::Discipline(v) => Self::Discipline(v.validate()?),
            Self::Family(v) => Self::Family(v.validate()?),
            Self::Disability(v) => Self::Disability(v.validate()?),
            Self::Veteran(v) => Self::Veteran(v.validate()?),
        })
    }
}

/// A void or correction reason: required for a void, optional for an update.
///
/// # Errors
/// Validation when it is empty, too long, or holds an identifier.
pub fn validate_reason(
    reason: Option<String>,
    required: bool,
) -> Result<Option<String>, KernelError> {
    let reason = guard::optional_text(reason, 500, "reason")?;
    if required && reason.is_none() {
        return Err(KernelError::validation(
            "reason is required to void an entry",
        ));
    }
    Ok(reason)
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod tests_company;
