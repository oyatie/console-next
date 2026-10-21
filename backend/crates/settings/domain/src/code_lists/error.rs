//! Refusals from the reason-code catalog. Each carries a stable code (the
//! frontend catalog renders it first) and the input field it points at.

use super::ReasonDomain;
use console_kernel_core::KernelError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReasonError {
    /// The domain string names no registered domain.
    DomainUnknown(String),
    /// The code is not a system code or an active tenant code of the domain.
    CodeInvalid { domain: ReasonDomain, code: String },
    /// The code requires a note and none (or only whitespace) was given.
    NoteRequired { domain: ReasonDomain, code: String },
    /// The note is longer than [`super::NOTE_MAX_CHARS`].
    NoteTooLong,
    /// A tenant code label is blank or longer than [`super::LABEL_MAX_CHARS`].
    LabelInvalid { field: &'static str },
    /// System codes cannot be changed by a tenant.
    SystemCodeFixed { domain: ReasonDomain, code: String },
}

impl ReasonError {
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::DomainUnknown(_) => "reason_domain_invalid",
            Self::CodeInvalid { .. } => "reason_code_invalid",
            Self::NoteRequired { .. } => "reason_note_required",
            Self::NoteTooLong => "reason_note_too_long",
            Self::LabelInvalid { .. } => "reason_label_invalid",
            Self::SystemCodeFixed { .. } => "reason_code_system",
        }
    }

    #[must_use]
    pub const fn field(&self) -> &'static str {
        match self {
            Self::DomainUnknown(_) => "domain",
            Self::CodeInvalid { .. } | Self::SystemCodeFixed { .. } => "reason_code",
            Self::NoteRequired { .. } | Self::NoteTooLong => "reason_note",
            Self::LabelInvalid { field } => field,
        }
    }
}

impl std::fmt::Display for ReasonError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DomainUnknown(d) => write!(f, "unknown reason domain: {d}"),
            Self::CodeInvalid { domain, code } => write!(
                f,
                "reason code {code} is not an active code of {}",
                domain.as_str()
            ),
            Self::NoteRequired { domain, code } => write!(
                f,
                "reason code {code} of {} requires a note",
                domain.as_str()
            ),
            Self::NoteTooLong => write!(
                f,
                "reason note is longer than {} characters",
                super::NOTE_MAX_CHARS
            ),
            Self::LabelInvalid { field } => write!(
                f,
                "{field} must be 1 to {} characters",
                super::LABEL_MAX_CHARS
            ),
            Self::SystemCodeFixed { domain, code } => write!(
                f,
                "system reason code {code} of {} cannot be changed",
                domain.as_str()
            ),
        }
    }
}

impl std::error::Error for ReasonError {}

impl From<ReasonError> for KernelError {
    fn from(error: ReasonError) -> Self {
        KernelError::validation(error.to_string())
            .with_code(error.code())
            .with_field(error.field())
    }
}
