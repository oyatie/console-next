//! CAP-04 (decisions #27, #28): the bulk 발령 as a job. `Prefer:
//! respond-async` makes `POST /employees/lifecycle-events/bulk` answer 202
//! once the request's own checks pass and the job row is written; a driver
//! then runs the batch exactly as the synchronous request does (one
//! transaction, all or nothing, the same Idempotency-Key claim and audit
//! rows). Each progress step is audited (`employee.lifecycle.bulk.progress`,
//! ids and counts only), the job's realtime topic; `GET …/bulk/jobs/{id}`
//! reads it. The batch's atomicity is kept on purpose: a crash leaves no half
//! 발령, and the job is finished by the schedule loop from what committed.

use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use console_platform_authz::Principal;
use console_platform_db::{with_audits, with_org_conn};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row};
use time::OffsetDateTime;
use uuid::Uuid;

use super::bulk_plan::bulk_input;
use super::requests::BulkEmployeeLifecycleEventRequest;
use crate::idempotency::idempotency_key_reused;
use crate::{HrError, HrService};

pub use super::bulk_job_slot::{DriverSlot, MAX_DRIVERS, RETRY_AFTER_SECS};

/// Employees between two progress steps.
pub(crate) const PROGRESS_EVERY: usize = 100;
/// A running job with no step for this long has no live driver: the batch
/// transaction is bounded by the serving `transaction_timeout` (45 s), and
/// every step stamps the heartbeat.
pub const STALE_AFTER_SECS: i32 = 120;

/// How long a job's batch may run: the synchronous request's 30 s budget.
const JOB_BUDGET: std::time::Duration = std::time::Duration::from_secs(30);

fn timed_out() -> HrError {
    HrError {
        errors: None,
        status: http::StatusCode::SERVICE_UNAVAILABLE,
        code: "bulk_job_timed_out",
        message: "the 발령 did not finish within 30 s and nothing was recorded; send it again"
            .to_owned(),
        refusals: None,
    }
}

/// A job as `GET …/bulk/jobs/{id}` returns it.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BulkLifecycleJob {
    pub id: Uuid,
    /// `queued`, `running`, `done` or `failed`.
    pub state: String,
    /// `checking` or `recording` while running.
    pub phase: Option<String>,
    pub total: i32,
    pub done: i32,
    /// The batch response (`batch_id`, `items`) once done.
    pub result: Option<Value>,
    /// `{code, message, refusals?}` once failed.
    pub error: Option<Value>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub finished_at: Option<OffsetDateTime>,
}

pub(super) const JOB_COLUMNS: &str = "id, state, phase, total, done, result, error, created_at, finished_at, requested_by, \
     idempotency_key, request";

pub(super) fn job_from_row(row: &sqlx::postgres::PgRow) -> Result<BulkLifecycleJob, HrError> {
    Ok(BulkLifecycleJob {
        id: row.try_get("id")?,
        state: row.try_get("state")?,
        phase: row.try_get("phase")?,
        total: row.try_get("total")?,
        done: row.try_get("done")?,
        result: row.try_get("result")?,
        error: row.try_get("error")?,
        created_at: row.try_get("created_at")?,
        finished_at: row.try_get("finished_at")?,
    })
}

/// The job's realtime event (`employee_lifecycle_bulk_job`; ids and counts).
pub(super) fn progress_audit(
    org: OrgId,
    actor: UserId,
    job: &BulkLifecycleJob,
) -> Result<AuditEvent, HrError> {
    Ok(AuditEvent::new(
        Some(actor),
        AuditAction::new("employee.lifecycle.bulk.progress").map_err(HrError::from_kernel)?,
        "employee_lifecycle_bulk_job",
        job.id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org)
    .with_snapshots(
        None,
        Some(json!({
            "job_id": job.id,
            "state": job.state,
            "phase": job.phase,
            "done": job.done,
            "total": job.total,
            "error": job.error.as_ref().map(|e| e["code"].clone()),
        })),
    ))
}

/// Writes one job update and its progress event; returns the job.
pub(super) async fn update(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: OrgId,
    id: Uuid,
    set: &str,
    guard: &str,
    bind: impl FnOnce(
        sqlx::query::Query<'_, Postgres, sqlx::postgres::PgArguments>,
    ) -> sqlx::query::Query<'_, Postgres, sqlx::postgres::PgArguments>,
) -> Result<Option<(BulkLifecycleJob, UserId)>, HrError> {
    let sql = format!(
        "UPDATE employee_lifecycle_bulk_jobs SET {set}, heartbeat_at = now() \
          WHERE org_id = $1 AND id = $2 AND state IN ('queued', 'running'){guard} RETURNING {JOB_COLUMNS}"
    );
    let query = bind(
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(*org.as_uuid())
            .bind(id),
    );
    let Some(row) = query.fetch_optional(tx.as_mut()).await? else {
        return Ok(None);
    };
    Ok(Some((
        job_from_row(&row)?,
        UserId::from_uuid(row.try_get("requested_by")?),
    )))
}

async fn audited_update(
    pool: &PgPool,
    org: OrgId,
    id: Uuid,
    (set, guard): (&'static str, &'static str),
    values: (Option<&'static str>, i32, i32, Option<Value>),
) -> Result<(), HrError> {
    let (phase, done, total, payload) = values;
    with_audits::<_, _, HrError>(pool, org, move |tx| {
        Box::pin(async move {
            let updated = update(tx, org, id, set, guard, |q| {
                q.bind(phase).bind(done).bind(total).bind(payload)
            })
            .await?;
            let audits = match &updated {
                Some((job, actor)) => vec![progress_audit(org, *actor, job)?],
                None => Vec::new(),
            };
            Ok(((), audits))
        })
    })
    .await
}

const STEP: &str = "state = 'running', phase = $3, done = $4, total = $5, result = $6";
/// Steps land out of order (each is its own task): only a later one writes.
const LATER_STEP: &str = " AND (COALESCE(phase, '') < $3 OR (phase = $3 AND done < $4))";
pub(super) const DONE: &str = "state = 'done', phase = $3, done = $4, total = $5, result = $6, \
     finished_at = now()";
pub(super) const FAILED: &str = "state = 'failed', phase = $3, done = $4, total = $5, error = $6, \
     finished_at = now()";

/// A running job's reporter: each step is its own short transaction on its
/// own connection, while the batch transaction is open.
#[derive(Clone)]
pub struct BulkProgress {
    pool: PgPool,
    org: OrgId,
    job: Uuid,
}

impl BulkProgress {
    /// Reports a step on its own task, so the batch, which holds the tenant's
    /// period lock, never waits on a second pooled connection.
    pub(crate) fn step(&self, phase: &'static str, done: usize, total: usize) {
        let count = |n: usize| i32::try_from(n).unwrap_or(i32::MAX);
        let this = self.clone();
        tokio::spawn(async move {
            if let Err(error) = audited_update(
                &this.pool,
                this.org,
                this.job,
                (STEP, LATER_STEP),
                (Some(phase), count(done), count(total), None),
            )
            .await
            {
                tracing::debug!(job = %this.job, code = error.code, "bulk job progress was not stored");
            }
        });
    }
}

impl HrService {
    /// Accepts a bulk 발령 as a job: the request's own checks refuse at once
    /// (422, nothing written); the job row is the Idempotency-Key's, so the
    /// same key and body answer the same job (`false`: nothing to drive) and
    /// another body is 409 `idempotency_key_reused`.
    pub async fn accept_bulk_lifecycle_job(
        &self,
        principal: &Principal,
        idempotency_key: String,
        request: Value,
    ) -> Result<(BulkLifecycleJob, bool), HrError> {
        let body: BulkEmployeeLifecycleEventRequest = serde_json::from_value(request.clone())
            .map_err(|_| HrError::validation("bulk request is not readable"))?;
        bulk_input(body)?;
        let org = principal.org_id;
        let actor = principal.user_id;
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let text = request.to_string();
                let inserted = sqlx::query(sqlx::AssertSqlSafe(format!(
                    "INSERT INTO employee_lifecycle_bulk_jobs \
                       (org_id, idempotency_key, request_fingerprint, request, requested_by) \
                     VALUES ($1, $2, encode(sha256(convert_to($3, 'UTF8')), 'hex'), $3::jsonb, $4) \
                     ON CONFLICT (org_id, idempotency_key) DO NOTHING RETURNING {JOB_COLUMNS}"
                )))
                .bind(*org.as_uuid())
                .bind(&idempotency_key)
                .bind(&text)
                .bind(*actor.as_uuid())
                .fetch_optional(tx.as_mut())
                .await?;
                if let Some(row) = inserted {
                    let job = job_from_row(&row)?;
                    let audit = progress_audit(org, actor, &job)?;
                    return Ok(((job, true), vec![audit]));
                }
                let row = sqlx::query(sqlx::AssertSqlSafe(format!(
                    "SELECT {JOB_COLUMNS}, request_fingerprint = \
                       encode(sha256(convert_to($3, 'UTF8')), 'hex') AS same \
                     FROM employee_lifecycle_bulk_jobs WHERE org_id = $1 AND idempotency_key = $2"
                )))
                .bind(*org.as_uuid())
                .bind(&idempotency_key)
                .bind(&text)
                .fetch_one(tx.as_mut())
                .await?;
                if !row.try_get::<bool, _>("same")? {
                    return Err(idempotency_key_reused());
                }
                Ok(((job_from_row(&row)?, false), Vec::new()))
            })
        })
        .await
    }

    /// Drives the job on its own task, holding `slot` until it ends.
    pub fn spawn_bulk_lifecycle_job(self, principal: Principal, job: Uuid, slot: DriverSlot) {
        tokio::spawn(async move {
            let _slot = slot;
            self.drive_bulk_lifecycle_job(principal, job).await;
        });
    }

    /// Runs an accepted job's batch and stores its outcome (`done` with the
    /// batch response, or `failed` with the refusal). `principal` is the
    /// caller that was authorised when the job was accepted.
    pub async fn drive_bulk_lifecycle_job(&self, principal: Principal, job: Uuid) {
        let org = principal.org_id;
        let loaded = with_org_conn::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                Ok(sqlx::query(
                    "SELECT idempotency_key, request FROM employee_lifecycle_bulk_jobs \
                      WHERE org_id = $1 AND id = $2 AND state IN ('queued', 'running')",
                )
                .bind(*org.as_uuid())
                .bind(job)
                .fetch_optional(tx.as_mut())
                .await?)
            })
        })
        .await;
        let Ok(Some(row)) = loaded else {
            return;
        };
        let (Ok(key), Ok(request)) = (
            row.try_get::<String, _>("idempotency_key"),
            row.try_get::<Value, _>("request"),
        ) else {
            return;
        };
        let progress = BulkProgress {
            pool: self.pool.clone(),
            org,
            job,
        };
        let outcome = match serde_json::from_value::<BulkEmployeeLifecycleEventRequest>(request) {
            Ok(body) => {
                // The synchronous request's budget: a batch past it is dropped,
                // so its transaction rolls back and nothing is recorded.
                tokio::time::timeout(
                    JOB_BUDGET,
                    self.run_bulk_lifecycle_events(principal, key, body, Some(progress)),
                )
                .await
                .unwrap_or_else(|_| Err(timed_out()))
            }
            Err(_) => Err(HrError::validation("bulk request is not readable")),
        };
        if let Err(error) = self.finish(org, job, outcome).await {
            tracing::warn!(%job, code = error.code, "bulk job outcome was not stored");
        }
    }

    async fn finish(
        &self,
        org: OrgId,
        job: Uuid,
        outcome: Result<Value, HrError>,
    ) -> Result<(), HrError> {
        match outcome {
            Ok(result) => {
                let total = result["items"]
                    .as_array()
                    .map_or(0, |items| i32::try_from(items.len()).unwrap_or(i32::MAX));
                audited_update(
                    &self.pool,
                    org,
                    job,
                    (DONE, ""),
                    (None, total, total, Some(result)),
                )
                .await
            }
            Err(error) => {
                let refusal = json!({
                    "code": error.code,
                    "message": error.message,
                    "refusals": error.refusals,
                });
                audited_update(
                    &self.pool,
                    org,
                    job,
                    (FAILED, ""),
                    (None, 0, 0, Some(refusal)),
                )
                .await
            }
        }
    }
}

#[cfg(test)]
mod tests {
    /// A job past its budget fails retryable: 503 `bulk_job_timed_out`, no
    /// per-person refusals (its batch rolled back, so nothing was recorded).
    #[test]
    fn a_job_past_its_budget_fails_503_bulk_job_timed_out() {
        let error = super::timed_out();
        assert_eq!(error.status, http::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error.code, "bulk_job_timed_out");
        assert!(error.refusals.is_none());
        assert!(error.message.contains("send it again"));
    }
}
