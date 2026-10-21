//! BW-06 governed exception record (예외 처리) and attestations. Pure: the
//! adapter stores `governed_exceptions` / `governed_exception_attestations`,
//! hashes the fingerprint and writes `settings_snapshot`.

mod attestation;
mod policy;
mod rule;

pub use attestation::{Attestation, AttestationCheck, AttestationDetails, validate_attestation};
pub use policy::{
    Admission, AdmissionFacts, DeciderFacts, Decision, ExceptionRecord, ExceptionSettings,
    ExceptionStatus, FallbackKind, SoleHolderMode, admit, check_admits, decide,
};
pub use rule::{Risk, RuleCode, RuleKind, SubjectType};
