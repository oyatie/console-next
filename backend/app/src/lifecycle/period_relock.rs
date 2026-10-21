//! BW-15 automatic re-lock (decisions #8b): when an unlock window's `relock_at`
//! passes, append the successor lock row for the same window, audited with no
//! actor. The lock is already in force from `relock_at` on, scheduler or not
//! (`period_lock_effective()`); this run only writes the row that history and
//! the next unlock build on. Idempotent: a window with a successor is skipped,
//! and rows another runner holds are skipped (`SKIP LOCKED`).
//!
//! `lifecycle_schedule.rs` calls it on every tick, beside the scheduled
//! lifecycle apply, in the api and worker roles alike.

use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext};
use console_platform_db::period_lock::relock_expired_in_tx;
use console_platform_db::with_audits;
use serde_json::json;
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

use super::LifecycleError;

/// Re-lock every expired unlock window in every tenant; returns how many
/// windows were re-locked. One tenant's fault is logged and retried next run.
// console-gate: state-changing-handler
pub async fn relock_due(pool: &PgPool) -> Result<usize, String> {
    let orgs: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM platform_list_organizations()")
        // rls-arming: ok platform_list_organizations() is the SECURITY DEFINER id-only tenant discovery; every per-org statement below runs under with_audits
        .fetch_all(pool)
        .await
        .map_err(|error| error.to_string())?;
    let mut relocked = 0;
    for org_uuid in orgs {
        let org = OrgId::from_uuid(org_uuid);
        let run = with_audits::<_, _, LifecycleError>(pool, org, move |tx| {
            Box::pin(async move {
                let pairs = relock_expired_in_tx(tx).await?;
                let events = pairs
                    .iter()
                    .map(|(expired, successor)| relock_event(org, *expired, *successor))
                    .collect::<Result<Vec<_>, _>>()?;
                Ok((pairs.len(), events))
            })
        })
        .await;
        match run {
            Ok(count) => relocked += count,
            Err(error) => {
                tracing::warn!(org = %org, ?error, "period re-lock failed; retrying next run");
            }
        }
    }
    Ok(relocked)
}

fn relock_event(org: OrgId, expired: Uuid, successor: Uuid) -> Result<AuditEvent, LifecycleError> {
    Ok(AuditEvent::new(
        None,
        AuditAction::new("period_lock.relock")?,
        "period_lock",
        successor.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_source(console_kernel_core::AuditSource::Scheduler)
    .with_org(org)
    .with_snapshots(None, Some(json!({ "relocks": expired }))))
}
