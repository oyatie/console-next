//! 인사카드 sections. MR-31: 학력, 자격·면허, 병역, 교육 이수 — the
//! 「기타 사항 (필요시 학력, 병역 사항, 기능·자격 사항, 교육 이수 내역 등)」 of
//! 근로기준법 시행규칙 별지 제16호서식. MR-33: 어학, 포상, 징계, 가족. MR-35:
//! 장애, 보훈 (restricted, with a 개인정보 보호법 §23① basis). An entry is a
//! fact of the natural person; every change is a new revision (CREATE,
//! UPDATE = correction, VOID).
//!
//! Pure rules only: the field shapes and their checks, and the import-sheet
//! row decision. PII minimisation is structural: there is no field for a 면제
//! 사유, a 전역 구분 or a 운전면허번호 (개인정보 보호법 §23, §24, 시행령 §19).

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
    /// MR-31's four, MR-33's four (상벌 is 포상 + 징계) and MR-35's two.
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

    /// 병역, 장애 and 보훈 are one status per person: a second live entry is
    /// refused and an import row without an entry id corrects the live one.
    #[must_use]
    pub const fn single_live(self) -> bool {
        matches!(self, Self::Military | Self::Disability | Self::Veteran)
    }

    /// Restricted: left out of the plain 인사카드 read, read only with a
    /// purpose (audited), never exported as a sheet, and gated by the
    /// `employee_restricted_record` Cedar action. 장애·보훈 are 민감정보
    /// (§23①); 징계 is held back for the 징계 domain the access model reserves.
    ///
    /// 징계 rides this gate until the access model's 징계 domain
    /// mounts; move it to that domain's grant then.
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
