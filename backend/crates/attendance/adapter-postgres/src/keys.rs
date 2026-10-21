//! Request fingerprints, the idempotency-key lock every attendance write
//! takes before it looks for a replay, and the audit event it writes (moved
//! out of lib.rs).

use console_attendance_application::{self as app, CallerScope};
use console_kernel_core::{AuditAction, AuditEvent, BranchId, OrgId, TraceContext};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::AttendanceStoreError;

pub(crate) fn fingerprint(value: &Value) -> String {
    hex::encode(Sha256::digest(value.to_string()))
}

pub(crate) async fn idempotency_lock(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    normalized_key: &str,
) -> Result<(), AttendanceStoreError> {
    let material = format!(
        "attendance-idempotency-v1|{}|{}|{}",
        org_id,
        normalized_key.len(),
        normalized_key
    );
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(material)
        .execute(tx.as_mut())
        .await?;
    Ok(())
}

pub(crate) fn event(
    caller: &CallerScope,
    action: &str,
    kind: &str,
    id: Uuid,
    branch: Option<Uuid>,
    after: Option<Value>,
) -> Result<AuditEvent, AttendanceStoreError> {
    let mut e = AuditEvent::new(
        Some(console_kernel_core::UserId::from_uuid(caller.user_id)),
        AuditAction::new(action).map_err(|_| {
            AttendanceStoreError::Application(app::AttendanceApplicationError::InvalidText(
                "audit action",
            ))
        })?,
        kind,
        id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(OrgId::from_uuid(caller.org_id))
    .with_snapshots(None, after);
    if let Some(branch) = branch {
        e = e.with_branch(BranchId::from_uuid(branch));
    }
    Ok(e)
}
