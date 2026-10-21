//! Attestation of an offline fact (decisions.md #3): the BW-06 record with
//! `rule_code = fact_code`, plus the row that carries what the law measures.
//! Both rows are written in the caller's transaction or neither is.

use console_governance_domain::exception::{
    Attestation, ExceptionSettings, SubjectType, validate_attestation,
};
use console_kernel_core::{KernelError, UserId};
use sqlx::PgConnection;
use uuid::Uuid;

use super::{ExceptionRequest, insert_exception_conn};
use crate::PgGovernanceError;

#[derive(Debug, Clone)]
pub struct AttestRequest<'a> {
    pub attestation: &'a Attestation,
    pub subject_type: SubjectType,
    pub subject_id: Uuid,
    /// BW-07 reason code, validated against the catalog by the caller.
    pub reason_code: &'a str,
    pub note: Option<&'a str>,
    pub attested_by: UserId,
    /// A step-up assertion the caller verified; required where the fact closes a legal clock.
    pub step_up_assertion_id: Option<Uuid>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttestedFact {
    pub exception_id: Uuid,
    pub attestation_id: Uuid,
    /// 상실신고 완료 without a 접수번호: the caller raises the review flag.
    pub review_flag: bool,
}

pub async fn attest_conn(
    conn: &mut PgConnection,
    request: &AttestRequest<'_>,
    settings: &ExceptionSettings,
) -> Result<AttestedFact, PgGovernanceError> {
    let check = validate_attestation(request.attestation)?;
    let payload = serde_json::to_value(request.attestation)
        .map_err(|e| KernelError::internal(format!("attestation payload: {e}")))?;
    let exception = ExceptionRequest {
        rule: request.attestation.fact,
        subject_type: request.subject_type,
        subject_id: request.subject_id,
        reason_code: request.reason_code,
        note: request.note,
        payload: &payload,
        affected_periods: &[],
        requested_by: request.attested_by,
        step_up_assertion_id: request.step_up_assertion_id,
        // Facts are low or medium risk: no second person is ever needed.
        other_eligible_holders: 0,
    };
    let recorded = insert_exception_conn(conn, &exception, settings).await?;
    let d = &request.attestation.details;
    let attestation_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO governed_exception_attestations
            (org_id, exception_id, fact_date, evidence_ref, method_code, detail_code,
             new_due_date, amount_krw, reference, receipt_numbers, filer, attested_by,
             step_up_assertion_id, created_at)
        SELECT org_id, id, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, created_at
        FROM governed_exceptions WHERE id = $1
        RETURNING id
        "#,
    )
    .bind(recorded.id)
    .bind(request.attestation.fact_date)
    .bind(trimmed(d.evidence_ref.as_deref()))
    .bind(trimmed(d.method_code.as_deref()))
    .bind(trimmed(d.detail_code.as_deref()))
    .bind(d.new_due_date)
    .bind(d.amount_krw)
    .bind(trimmed(d.reference.as_deref()))
    .bind(
        d.receipt_numbers
            .iter()
            .map(|n| n.trim())
            .filter(|n| !n.is_empty())
            .collect::<Vec<_>>(),
    )
    .bind(trimmed(d.filer.as_deref()))
    .bind(*request.attested_by.as_uuid())
    .bind(request.step_up_assertion_id)
    .fetch_one(conn)
    .await?;
    Ok(AttestedFact {
        exception_id: recorded.id,
        attestation_id,
        review_flag: check.review_flag,
    })
}

fn trimmed(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|v| !v.is_empty())
}
