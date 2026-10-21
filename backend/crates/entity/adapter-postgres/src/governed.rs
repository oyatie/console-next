//! Consumer-declared seam to the BW-06 governed exceptions (governance owns
//! `governed_exceptions`): after 운영 시작 an identifier correction is admitted
//! only by consuming the approved, or sole-holder recorded, exception for
//! exactly that correction, inside the correction's own transaction.
//!
//! The composition root implements it over
//! `console_governance_adapter_postgres::consume_exception_conn` with rule
//! `ENTITY_IDENTIFIER_CORRECTION` (HIGH). Not wired ⇒ every post-go-live
//! correction is refused (fail closed).
//!
//! Decisions #26 item d: the tenant ops account may cover a correction itself
//! (break-glass) — [`GovernedCorrectionPort::cover_as_ops`] verifies its
//! step-up and records the exception (flagged for review) that `consume`
//! then takes.

use console_kernel_core::KernelError;
use serde_json::Value;
use sqlx::PgConnection;
use uuid::Uuid;

/// What the correction corrects (`governed_exceptions.subject_type`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CorrectionSubject {
    /// `LEGAL_ENTITY`: 사업자 구분 or 법인등록번호.
    LegalEntity(Uuid),
    /// `BUSINESS_REGISTRATION`: 사업자등록번호.
    BusinessRegistration(Uuid),
}

/// How the consumed exception was covered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CorrectionCover {
    /// A second person approved it.
    SecondPerson,
    /// The only eligible holder recorded it (decisions #7 case B).
    SoleHolder,
}

/// The future a [`GovernedCorrectionPort::consume`] returns (borrows the conn).
pub type GovernedCorrectionFuture<'a> = std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<CorrectionCover, KernelError>> + Send + 'a>,
>;

/// The future a [`GovernedCorrectionPort::cover_as_ops`] returns: the
/// recorded exception's id.
pub type OpsCoverFuture<'a> =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<Uuid, KernelError>> + Send + 'a>>;

/// The tenant ops account covering one correction (decisions #26 item d).
#[derive(Debug, Clone, Copy)]
pub struct OpsCover<'a> {
    pub org: console_kernel_core::OrgId,
    pub actor: Uuid,
    pub subject: CorrectionSubject,
    /// The canonical correction, as [`GovernedCorrectionPort::consume`] gets it.
    pub payload: &'a Value,
    /// The correction's reason code.
    pub reason_code: &'a str,
    /// The text the step-up is bound to
    /// ([`console_entity_domain::correction::IdentifierCorrection::ops_step_up_line`]).
    pub step_up_line: &'a str,
    /// The client's step-up envelope (`{binding, assertion}`).
    pub step_up: &'a Value,
}

pub trait GovernedCorrectionPort: Send + Sync {
    /// Verify the ops account's step-up and record the exception that covers
    /// the correction, or refuse (`passkey_step_up_failed`, `unavailable`,
    /// `exception_sole_holder_refused`, …).
    fn cover_as_ops<'tx>(
        &self,
        tx: &'tx mut sqlx::Transaction<'_, sqlx::Postgres>,
        cover: OpsCover<'tx>,
    ) -> OpsCoverFuture<'tx>;

    /// Consume `exception_id` for `subject` and `payload` (the canonical
    /// correction, [`console_entity_domain::correction::IdentifierCorrection::governed_payload`]),
    /// or refuse (`exception_not_approved`, `exception_scope_changed`, …).
    fn consume<'a>(
        &'a self,
        conn: &'a mut PgConnection,
        exception_id: Uuid,
        subject: CorrectionSubject,
        payload: &'a Value,
    ) -> GovernedCorrectionFuture<'a>;
}
