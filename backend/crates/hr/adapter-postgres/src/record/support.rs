//! Helpers shared by the commands, the reads and the import sheet: payload
//! digest, the entry view, audit rows, replay and target checks.

use console_hr_domain::record::Section;
use console_kernel_core::{AuditAction, AuditEvent, KernelError, OrgId, TraceContext, UserId};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use super::store::{self, Current};
use super::{RecordEntryView, version_conflict};
use crate::HrError;
use crate::idempotency::idempotency_key_reused;

pub(crate) fn digest(payload: &serde_json::Value) -> Vec<u8> {
    Sha256::digest(payload.to_string().as_bytes()).to_vec()
}

pub(crate) fn view(current: Current) -> RecordEntryView {
    RecordEntryView {
        id: current.head.entry_id,
        section: current.section,
        version: current.head.version,
        voided: current.voided(),
        source: current.head.source,
        fields: current.head.fields,
        created_at: current.created_at,
        revised_at: current.head.created_at,
    }
}

pub(crate) fn audit(
    org: OrgId,
    actor: UserId,
    action: &'static str,
    subject: (&'static str, Uuid),
    detail: serde_json::Value,
) -> Result<AuditEvent, HrError> {
    Ok(AuditEvent::new(
        Some(actor),
        AuditAction::new(action).map_err(HrError::from_kernel)?,
        subject.0,
        subject.1.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org)
    .with_snapshots(None, Some(detail)))
}

pub(crate) async fn current(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    entry: Uuid,
) -> Result<Current, HrError> {
    store::load_entry(tx, org, entry)
        .await?
        .ok_or_else(|| HrError::internal("recorded entry was not read back"))
}

/// The stored entry of a replayed key, or 409 when the key carried another payload.
pub(crate) async fn replay(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    command: Uuid,
    digest: &[u8],
) -> Result<Option<RecordEntryView>, HrError> {
    let Some((entry, stored)) = store::find_command(tx, org, command).await? else {
        return Ok(None);
    };
    if stored != digest {
        return Err(idempotency_key_reused());
    }
    Ok(Some(view(current(tx, org, entry).await?)))
}

/// The entry an update or void names, checked against the employee's person and the section.
pub(crate) async fn target(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    person: Uuid,
    section: Section,
    entry: Uuid,
    expected_version: i64,
) -> Result<Current, HrError> {
    let found = store::load_entry(tx, org, entry)
        .await?
        .filter(|c| c.person_id == person && c.section == section)
        .ok_or_else(|| {
            HrError::from_kernel(KernelError::not_found("record entry was not found"))
        })?;
    if found.head.version != expected_version {
        return Err(version_conflict(found.head.version));
    }
    Ok(found)
}

pub(crate) fn single_entry_exists(section: Section) -> HrError {
    HrError {
        status: http::StatusCode::CONFLICT,
        code: "record_single_entry_exists",
        message: format!(
            "a live {} entry exists; correct that entry instead",
            section.segment()
        ),
        refusals: None,
    }
}
