//! BW-06 persistence: `governed_exceptions` and `governed_exception_attestations`.
//!
//! Connection-level primitives. The caller owns the transaction (its
//! `with_audit` arms `app.current_org`), because an exception is recorded inside
//! the command that needs it and consumed inside the governed write it admits.
//! One clock: the transaction's `now()`. The fingerprint is the migration's
//! `governed_exception_fingerprint(payload, periods)`, so request and consume
//! cannot hash differently.
//!
//! A decision passes the domain `decide` rules (specific codes, e.g.
//! `step_up_required`) and then Cedar `exception_decide`; both must allow.
//! Not here yet: routes, and the executive notice
//! (`Admission::notify_executives` is returned to the caller until a
//! notifications outbox exists).

mod attest;
mod read;

use console_governance_domain::exception::{
    Admission, AdmissionFacts, DeciderFacts, Decision, ExceptionSettings, ExceptionStatus,
    RuleCode, RuleKind, SubjectType, admit, check_admits, decide,
};
use console_kernel_core::{EffectivePeriod, KernelError, Timestamp, UserId};
use console_platform_authz::cedar_pbac::enforce::enforce_action;
use console_platform_authz::cedar_pbac::facts::Facts;
use console_platform_authz::{AuthorizationResource, Feature, Principal};
use serde_json::{Value, json};
use sqlx::PgConnection;
use sqlx::postgres::types::PgRange;
use std::ops::Bound;
use uuid::Uuid;

use crate::PgGovernanceError;

pub use attest::{AttestRequest, AttestedFact, attest_conn};
pub use read::{ExceptionFilter, StoredException, get_exception_conn, list_exceptions_conn};

/// A command that breaks a soft rule asks for an exception (BW-06).
#[derive(Debug, Clone)]
pub struct ExceptionRequest<'a> {
    pub rule: RuleCode,
    pub subject_type: SubjectType,
    pub subject_id: Uuid,
    /// BW-07 reason code, validated against the catalog by the caller.
    pub reason_code: &'a str,
    pub note: Option<&'a str>,
    /// Canonical payload of the write this exception admits.
    pub payload: &'a Value,
    /// Payroll or accounting periods that write touches (part of the fingerprint).
    pub affected_periods: &'a [EffectivePeriod],
    pub requested_by: UserId,
    /// A step-up assertion the caller verified for this payload. Its presence is
    /// the domain's `step_up` fact, so the two can never disagree.
    pub step_up_assertion_id: Option<Uuid>,
    /// D0.2 count of other eligible holders, computed by the caller in this transaction.
    pub other_eligible_holders: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequestedException {
    pub id: Uuid,
    /// PENDING waits for a second person; RECORDED admits the write now.
    /// `notify_executives` is the caller's to deliver in the same transaction.
    pub admission: Admission,
}

/// Record an exception for a soft rule. Attested facts go through [`attest_conn`].
pub async fn request_exception_conn(
    conn: &mut PgConnection,
    request: &ExceptionRequest<'_>,
    settings: &ExceptionSettings,
) -> Result<RequestedException, PgGovernanceError> {
    if request.rule.kind() == RuleKind::Fact {
        return Err(KernelError::validation("exception_fact_needs_attestation").into());
    }
    insert_exception_conn(conn, request, settings).await
}

async fn insert_exception_conn(
    conn: &mut PgConnection,
    request: &ExceptionRequest<'_>,
    settings: &ExceptionSettings,
) -> Result<RequestedException, PgGovernanceError> {
    let reason_code = request.reason_code.trim();
    if reason_code.is_empty() {
        return Err(KernelError::validation("reason_code_invalid").into());
    }
    let now = db_now(conn).await?;
    let facts = AdmissionFacts {
        other_eligible_holders: request.other_eligible_holders,
        step_up: request.step_up_assertion_id.is_some(),
    };
    let admission = admit(request.rule.risk(), facts, settings, now)?;
    let id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO governed_exceptions
            (org_id, rule_code, risk, subject_type, subject_id, reason_code, note,
             fingerprint, affected_periods, settings_snapshot, requested_by,
             step_up_assertion_id, status, fallback_kind, review_due_at, expires_at, created_at)
        VALUES (NULLIF(current_setting('app.current_org', true), '')::uuid,
                $1, $2, $3, $4, $5, $6,
                governed_exception_fingerprint($7, $8), $8, $9, $10,
                $11, $12, $13, $14, $15, $16)
        RETURNING id
        "#,
    )
    .bind(request.rule.as_str())
    .bind(request.rule.risk().as_db_str())
    .bind(request.subject_type.as_db_str())
    .bind(request.subject_id)
    .bind(reason_code)
    .bind(request.note.map(str::trim).filter(|n| !n.is_empty()))
    .bind(request.payload)
    .bind(periods(request.affected_periods))
    .bind(settings_snapshot(settings))
    .bind(*request.requested_by.as_uuid())
    .bind(request.step_up_assertion_id)
    .bind(admission.status.as_db_str())
    .bind(admission.fallback_kind.map(read::fallback_db_str))
    .bind(admission.review_due_at)
    .bind(admission.expires_at)
    .bind(now)
    .fetch_one(conn)
    .await?;
    Ok(RequestedException { id, admission })
}

/// The second person's decision on a PENDING exception.
#[derive(Debug, Clone)]
pub struct ExceptionDecision<'a> {
    pub decision: Decision,
    pub decider: &'a Principal,
    /// The decider drafted or edited the subject (decisions.md #5).
    pub contributed: bool,
    /// The decider holds this rule's approving permission, computed by the
    /// caller in this transaction (e.g. period-lock managers for a 소급).
    pub holds_permission: bool,
    /// A verified `EXCEPTION_DECIDE` step-up bound to the payload hash.
    pub step_up_assertion_id: Option<Uuid>,
    pub reason_code: &'a str,
    pub note: Option<&'a str>,
}

pub async fn decide_exception_conn(
    conn: &mut PgConnection,
    id: Uuid,
    input: &ExceptionDecision<'_>,
) -> Result<ExceptionStatus, PgGovernanceError> {
    let reason_code = input.reason_code.trim();
    if reason_code.is_empty() {
        return Err(KernelError::validation("reason_code_invalid").into());
    }
    let stored = read::lock_exception_conn(conn, id).await?;
    let now = db_now(conn).await?;
    let facts = DeciderFacts {
        decider: input.decider.user_id,
        contributed: input.contributed,
        step_up: input.step_up_assertion_id.is_some(),
    };
    let status = decide(&stored.record(), input.decision, facts, now)?;
    authorize_decision(&stored, input)?;
    let step_up = match status {
        ExceptionStatus::Approved => input.step_up_assertion_id,
        _ => None,
    };
    sqlx::query(
        r#"
        UPDATE governed_exceptions
        SET status = $2, decided_by = $3, decided_at = $4, decision_reason_code = $5,
            decision_note = $6, decision_step_up_assertion_id = $7
        WHERE id = $1
        "#,
    )
    .bind(id)
    .bind(status.as_db_str())
    .bind(*input.decider.user_id.as_uuid())
    .bind(now)
    .bind(reason_code)
    .bind(input.note.map(str::trim).filter(|n| !n.is_empty()))
    .bind(step_up)
    .execute(conn)
    .await?;
    Ok(status)
}

/// Cedar `exception_decide` (BW-06 Cedar): the domain rules stay the backstop.
fn authorize_decision(
    stored: &StoredException,
    input: &ExceptionDecision<'_>,
) -> Result<(), KernelError> {
    let resource = AuthorizationResource::org_wide(stored.org_id, "governed_exception")
        .with_resource_id(stored.id.to_string());
    let facts = Facts::new()
        .bool(
            "actor_is_requester",
            stored.requested_by == input.decider.user_id,
        )
        .bool("actor_contributed", input.contributed)
        .bool("actor_holds_permission", input.holds_permission)
        .bool("step_up", input.step_up_assertion_id.is_some())
        .bool("is_approval", input.decision == Decision::Approve);
    enforce_action(input.decider, Feature::ExceptionDecide, resource, &facts)
}

/// What a governed write is about to do. The rule is the one THIS write needs.
#[derive(Debug, Clone)]
pub struct GovernedWrite<'a> {
    pub rule: RuleCode,
    pub subject_type: SubjectType,
    pub subject_id: Uuid,
    pub payload: &'a Value,
    pub affected_periods: &'a [EffectivePeriod],
}

/// The shared guard (decisions.md #5): admit exactly this one write and consume
/// the exception, inside the write's own transaction. A rolled-back write
/// un-consumes it.
pub async fn consume_exception_conn(
    conn: &mut PgConnection,
    id: Uuid,
    write: &GovernedWrite<'_>,
) -> Result<(), PgGovernanceError> {
    let stored = read::lock_exception_conn(conn, id).await?;
    let (fingerprint, now): (String, Timestamp) =
        sqlx::query_as("SELECT governed_exception_fingerprint($1, $2), now()")
            .bind(write.payload)
            .bind(periods(write.affected_periods))
            .fetch_one(&mut *conn)
            .await?;
    check_admits(
        &stored.record(),
        write.rule,
        write.subject_type,
        write.subject_id.as_u128(),
        &fingerprint,
        now,
    )?;
    sqlx::query("UPDATE governed_exceptions SET consumed_at = $2 WHERE id = $1")
        .bind(id)
        .bind(now)
        .execute(conn)
        .await?;
    Ok(())
}

async fn db_now(conn: &mut PgConnection) -> Result<Timestamp, PgGovernanceError> {
    Ok(sqlx::query_scalar("SELECT now()").fetch_one(conn).await?)
}

fn periods(periods: &[EffectivePeriod]) -> Vec<PgRange<time::Date>> {
    periods
        .iter()
        .map(|p| PgRange {
            start: Bound::Included(p.from),
            end: p.to_exclusive.map_or(Bound::Unbounded, Bound::Excluded),
        })
        .collect()
}

/// D0.3: the settings values the exception was admitted under, by registry key.
fn settings_snapshot(settings: &ExceptionSettings) -> Value {
    json!({
        "exceptions.approval_ttl_days": settings.approval_ttl_days,
        "authz.sole_holder.mode": settings.sole_holder_mode,
        "review.sole_holder_exception.due": settings.sole_holder_review_due.as_secs() / 86_400,
    })
}

#[cfg(test)]
#[path = "tests/db.rs"]
mod db_tests;
