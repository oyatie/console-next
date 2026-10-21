//! Reading governed exceptions. RLS scopes every row to the armed org, so an
//! exception of another tenant is simply not found.

use console_governance_domain::exception::{
    ExceptionRecord, ExceptionStatus, FallbackKind, Risk, RuleCode, SubjectType,
};
use console_kernel_core::{KernelError, OrgId, Timestamp, UserId};
use sqlx::postgres::PgRow;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::PgGovernanceError;

macro_rules! select_exception {
    ($tail:literal) => {
        concat!(
            "SELECT id, org_id, rule_code, risk, subject_type, subject_id, reason_code, note, fingerprint, \
             status, fallback_kind, requested_by, decided_by, review_due_at, expires_at, \
             created_at, decided_at, consumed_at FROM governed_exceptions ",
            $tail
        )
    };
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredException {
    pub id: Uuid,
    pub org_id: OrgId,
    pub rule: RuleCode,
    pub risk: Risk,
    pub subject_type: SubjectType,
    pub subject_id: Uuid,
    pub reason_code: String,
    pub note: Option<String>,
    pub fingerprint: String,
    pub status: ExceptionStatus,
    pub fallback_kind: Option<FallbackKind>,
    pub requested_by: UserId,
    pub decided_by: Option<UserId>,
    pub review_due_at: Option<Timestamp>,
    pub expires_at: Timestamp,
    pub created_at: Timestamp,
    pub decided_at: Option<Timestamp>,
    pub consumed_at: Option<Timestamp>,
}

impl StoredException {
    /// The record the domain's decide and admit rules read.
    #[must_use]
    pub fn record(&self) -> ExceptionRecord {
        ExceptionRecord {
            rule: self.rule,
            status: self.status,
            requested_by: self.requested_by,
            subject_type: self.subject_type,
            subject_id: self.subject_id.as_u128(),
            fingerprint: self.fingerprint.clone(),
            expires_at: self.expires_at,
            consumed: self.consumed_at.is_some(),
        }
    }
}

/// Filters of `GET /api/v1/exceptions` (BW-06). `None` matches everything.
#[derive(Debug, Clone, Copy, Default)]
pub struct ExceptionFilter {
    pub status: Option<ExceptionStatus>,
    pub rule: Option<RuleCode>,
    pub created_from: Option<Timestamp>,
    pub created_to: Option<Timestamp>,
}

pub async fn get_exception_conn(
    conn: &mut PgConnection,
    id: Uuid,
) -> Result<Option<StoredException>, PgGovernanceError> {
    let row = sqlx::query(select_exception!("WHERE id = $1"))
        .bind(id)
        .fetch_optional(conn)
        .await?;
    row.as_ref().map(stored_from_row).transpose()
}

/// Newest first, at most `limit` rows.
// no keyset cursor yet; the REST step adds one with the route.
pub async fn list_exceptions_conn(
    conn: &mut PgConnection,
    filter: ExceptionFilter,
    limit: i64,
) -> Result<Vec<StoredException>, PgGovernanceError> {
    let rows = sqlx::query(select_exception!(
        "WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR rule_code = $2) \
         AND ($3::timestamptz IS NULL OR created_at >= $3) \
         AND ($4::timestamptz IS NULL OR created_at < $4) \
         ORDER BY created_at DESC, id DESC LIMIT $5"
    ))
    .bind(filter.status.map(ExceptionStatus::as_db_str))
    .bind(filter.rule.map(RuleCode::as_str))
    .bind(filter.created_from)
    .bind(filter.created_to)
    .bind(limit.clamp(1, 500))
    .fetch_all(conn)
    .await?;
    rows.iter().map(stored_from_row).collect()
}

/// Load and row-lock one exception for a decision or a consumption.
pub(super) async fn lock_exception_conn(
    conn: &mut PgConnection,
    id: Uuid,
) -> Result<StoredException, PgGovernanceError> {
    let row = sqlx::query(select_exception!("WHERE id = $1 FOR UPDATE"))
        .bind(id)
        .fetch_optional(conn)
        .await?
        .ok_or_else(|| KernelError::not_found("exception_not_found"))?;
    stored_from_row(&row)
}

pub(super) const fn fallback_db_str(kind: FallbackKind) -> &'static str {
    match kind {
        FallbackKind::SecondPerson => "SECOND_PERSON",
        FallbackKind::SoleHolder => "SOLE_HOLDER",
    }
}

fn pick<T: Copy>(all: &[T], name: fn(T) -> &'static str, value: &str) -> Result<T, KernelError> {
    all.iter()
        .copied()
        .find(|v| name(*v) == value)
        .ok_or_else(|| {
            KernelError::internal(format!("governed_exceptions holds unknown {value:?}"))
        })
}

fn stored_from_row(row: &PgRow) -> Result<StoredException, PgGovernanceError> {
    use ExceptionStatus as S;
    let status: String = row.try_get("status")?;
    let risk: String = row.try_get("risk")?;
    let subject_type: String = row.try_get("subject_type")?;
    let rule: String = row.try_get("rule_code")?;
    let fallback: Option<String> = row.try_get("fallback_kind")?;
    let all_fallbacks = [FallbackKind::SecondPerson, FallbackKind::SoleHolder];
    Ok(StoredException {
        id: row.try_get("id")?,
        org_id: OrgId::from_uuid(row.try_get("org_id")?),
        rule: RuleCode::parse(&rule)?,
        risk: pick(
            &[Risk::Low, Risk::Medium, Risk::High],
            Risk::as_db_str,
            &risk,
        )?,
        subject_type: SubjectType::from_db_str(&subject_type)?,
        subject_id: row.try_get("subject_id")?,
        reason_code: row.try_get("reason_code")?,
        note: row.try_get("note")?,
        fingerprint: row.try_get("fingerprint")?,
        status: pick(
            &[S::Pending, S::Approved, S::Declined, S::Recorded],
            S::as_db_str,
            &status,
        )?,
        fallback_kind: fallback
            .map(|f| pick(&all_fallbacks, fallback_db_str, &f))
            .transpose()?,
        requested_by: UserId::from_uuid(row.try_get("requested_by")?),
        decided_by: row
            .try_get::<Option<Uuid>, _>("decided_by")?
            .map(UserId::from_uuid),
        review_due_at: row.try_get("review_due_at")?,
        expires_at: row.try_get("expires_at")?,
        created_at: row.try_get("created_at")?,
        decided_at: row.try_get("decided_at")?,
        consumed_at: row.try_get("consumed_at")?,
    })
}
