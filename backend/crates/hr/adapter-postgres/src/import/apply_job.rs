//! W11 (decisions #27, #28): the employee import apply as a job. The route
//! checks everything a refusal needs synchronously (digest, unsettled rows,
//! row limit), records the job on the run (`apply_job`) and returns; a driver
//! then runs the leave command (all rows, one statement) and the settle in
//! chunks of [`SETTLE_CHUNK_ROWS`], each chunk one transaction with a
//! `data_import.apply.progress` audit row — the realtime topic of the run.
//! Every write is idempotent, so a job whose process died is resumed by the
//! schedule loop (settle phase) or by the operator re-sending the apply.

use std::sync::atomic::{AtomicUsize, Ordering};

use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use console_settings_domain::SettingKey;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Postgres;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::HrError;
use crate::import::caps::settings_in_tx;
use crate::import::types::EmployeeImportReport;

pub use crate::import::settle::SETTLE_CHUNK_ROWS;

/// Seconds after which a running job with no heartbeat is resumed: longer
/// than the leave command of a run at `import.apply.max_rows` (the driver
/// stamps the heartbeat right before it), so a live driver is never joined.
/// a fixed lease; renew it inside the statement if a run ever nears it.
pub const STALE_AFTER_SECS: i32 = 300;

/// Apply drivers one process runs at once (#28 load shedding: the next
/// request is 503 `import_apply_busy` with `Retry-After`).
/// a per-process cap; a tenant-fair queue if many tenants import at once.
pub const MAX_DRIVERS: usize = 2;
/// The `Retry-After` of `import_apply_busy`, in seconds.
pub const RETRY_AFTER_SECS: u32 = 15;

static DRIVERS: AtomicUsize = AtomicUsize::new(0);

/// One of the [`MAX_DRIVERS`] driver slots; released on drop.
#[derive(Debug)]
pub struct DriverSlot(());

impl DriverSlot {
    /// A free slot, or 503 `import_apply_busy`.
    ///
    /// # Errors
    /// `import_apply_busy` when every slot is taken.
    pub fn take() -> Result<Self, HrError> {
        DRIVERS
            .try_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < MAX_DRIVERS).then_some(n + 1)
            })
            .map(|_| Self(()))
            .map_err(|_| HrError {
                errors: None,
                status: http::StatusCode::SERVICE_UNAVAILABLE,
                code: "import_apply_busy",
                message: format!(
                    "too many imports are being applied; retry in {RETRY_AFTER_SECS} s"
                ),
                refusals: None,
            })
    }
}

impl Drop for DriverSlot {
    fn drop(&mut self) {
        DRIVERS.fetch_sub(1, Ordering::AcqRel);
    }
}

/// The job of a run, as stored and as `GET …/apply` returns it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplyJob {
    pub run_id: Uuid,
    /// `queued`, `applying`, `settling`, `done`, `failed`.
    pub state: String,
    pub dry_run_digest: String,
    pub requested_by: Uuid,
    /// Plan rows the settle covers, and how many are done.
    pub total: usize,
    pub done: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report: Option<EmployeeImportReport>,
    /// `{code, message, refusals?}` of a job that failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
}

impl ApplyJob {
    #[must_use]
    pub fn queued(run_id: Uuid, digest: &str, actor: UserId) -> Self {
        Self {
            run_id,
            state: "queued".into(),
            dry_run_digest: digest.to_owned(),
            requested_by: *actor.as_uuid(),
            total: 0,
            done: 0,
            report: None,
            error: None,
        }
    }

    #[must_use]
    pub fn running(&self) -> bool {
        matches!(self.state.as_str(), "queued" | "applying" | "settling")
    }

    #[must_use]
    pub fn failed(mut self, error: &HrError) -> Self {
        self.state = "failed".into();
        self.error = Some(json!({
            "code": error.code,
            "message": error.message,
            "refusals": error.refusals,
        }));
        self
    }
}

/// The run's job, if one was ever started.
pub async fn read_job(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    run: Uuid,
) -> Result<Option<ApplyJob>, HrError> {
    let job: Option<Value> =
        sqlx::query_scalar("SELECT apply_job FROM data_import_runs WHERE org_id = $1 AND id = $2")
            .bind(org)
            .bind(run)
            .fetch_optional(tx.as_mut())
            .await?
            .flatten();
    job.map(serde_json::from_value)
        .transpose()
        .map_err(|_| HrError::internal("stored import apply job is unreadable"))
}

/// Stores `job` and stamps the heartbeat.
pub async fn write_job(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    job: &ApplyJob,
) -> Result<(), HrError> {
    sqlx::query(
        "UPDATE data_import_runs SET apply_job = $3, apply_heartbeat_at = now(), updated_at = now() \
          WHERE org_id = $1 AND id = $2",
    )
    .bind(org)
    .bind(job.run_id)
    .bind(json!(job))
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

/// The audit row a job writes with each step: the run's realtime event
/// (`data_import_run` / `data_import.apply.progress`; ids and counts only).
///
/// # Errors
/// Only for an invalid action code (never, it is a literal).
pub fn progress_audit(org: OrgId, job: &ApplyJob) -> Result<AuditEvent, HrError> {
    Ok(AuditEvent::new(
        Some(UserId::from_uuid(job.requested_by)),
        AuditAction::new("data_import.apply.progress").map_err(HrError::from_kernel)?,
        "data_import_run",
        job.run_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_source(console_kernel_core::AuditSource::Import)
    .with_org(org)
    .with_snapshots(
        None,
        Some(json!({
            "run_id": job.run_id,
            "state": job.state,
            "done": job.done,
            "total": job.total,
            "error": job.error.as_ref().map(|e| e["code"].clone()),
        })),
    ))
}

/// 422 `import_row_limit` when the run has more candidate rows than
/// `import.apply.max_rows` (#28: work per run is bounded).
///
/// # Errors
/// `import_row_limit` with `{max, rows}`.
/// The run's rows that count against `import.apply.max_rows`: current
/// people only. r3:hire-17: former employees (a 퇴사일 on the row) come in
/// the same run apart from the cap, so a 2,000-person tenant migrates its
/// staff and its 퇴사자 sheet in one pass (#28).
pub async fn require_row_limit(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    run: Uuid,
) -> Result<(), HrError> {
    let rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM data_import_rows \
          WHERE org_id = $1 AND run_id = $2 AND row_status = 'CANDIDATE' \
            AND COALESCE(canonical_row->'canonical'->>'employment_status', '') <> 'EXITED'",
    )
    .bind(org)
    .bind(run)
    .fetch_one(tx.as_mut())
    .await?;
    let key = SettingKey::ImportApplyMaxRows;
    let max = settings_in_tx(tx, org, &[key])
        .await?
        .get(&key)
        .and_then(|v| v.as_int())
        .ok_or_else(|| HrError::internal("import.apply.max_rows did not resolve"))?;
    if rows > max {
        return Err(HrError {
            errors: None,
            status: http::StatusCode::UNPROCESSABLE_ENTITY,
            code: "import_row_limit",
            message: format!(
                "the run has {rows} rows; at most {max} are applied at once (import.apply.max_rows); split the file"
            ),
            refusals: Some(Box::new(json!([{ "max": max, "rows": rows }]))),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::DriverSlot;

    /// #28 load shedding: past [`super::MAX_DRIVERS`] the next apply is 503
    /// `import_apply_busy` (the route adds `Retry-After`), until one frees.
    #[test]
    fn a_driver_past_the_cap_is_shed_until_one_frees() {
        let first = DriverSlot::take();
        let second = DriverSlot::take();
        assert!(first.is_ok() && second.is_ok());
        let shed = DriverSlot::take()
            .err()
            .map(|e| (e.status.as_u16(), e.code));
        assert_eq!(shed, Some((503, "import_apply_busy")));
        drop(first);
        assert!(DriverSlot::take().is_ok());
    }
}
