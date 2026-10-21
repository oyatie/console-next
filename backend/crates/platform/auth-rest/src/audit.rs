use crate::error::RestError;
use console_kernel_core::AuditAction;
use console_kernel_core::AuditEvent;
use console_kernel_core::OrgId;
use console_kernel_core::TraceContext;
use console_kernel_core::UserId;
use console_platform_db::with_audit;
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

#[cfg(feature = "dev-auth")]
pub(crate) async fn record_auth_audit(
    pool: &PgPool,
    org_id: OrgId,
    user_id: Uuid,
    action: &str,
    after: serde_json::Value,
) -> Result<(), RestError> {
    let event = auth_audit_event(org_id, user_id, action, after)?;
    with_audit::<_, (), RestError>(pool, event, |_tx| Box::pin(async move { Ok(()) })).await
}

pub(crate) fn auth_audit_event(
    org_id: OrgId,
    user_id: Uuid,
    action: &str,
    after: serde_json::Value,
) -> Result<AuditEvent, RestError> {
    Ok(AuditEvent::new(
        Some(UserId::from_uuid(user_id)),
        AuditAction::new(action).map_err(|err| RestError::internal(err.to_string()))?,
        "users",
        user_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org_id)
    .with_snapshots(None, Some(after)))
}

/// Audit a failed unauthenticated attempt with no actor and no PII (no OTP value,
/// no client IP) so the `pii-no-logs` gate and audit policy both hold.
pub(crate) async fn record_anonymous_auth_audit(
    pool: &PgPool,
    action: &str,
    after: serde_json::Value,
) -> Result<(), RestError> {
    let event = AuditEvent::new(
        None,
        AuditAction::new(action).map_err(|err| RestError::internal(err.to_string()))?,
        "auth_bootstrap_credential",
        "redeem",
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_snapshots(None, Some(after));

    with_audit::<_, (), RestError>(pool, event, |_tx| Box::pin(async move { Ok(()) })).await
}
