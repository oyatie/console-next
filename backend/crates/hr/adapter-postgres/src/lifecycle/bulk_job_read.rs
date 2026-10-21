//! CAP-04: the read side of a bulk 발령 job and the schedule loop's
//! finishing of a job whose driver died (see `bulk_job`).

use console_kernel_core::{AuditEvent, KernelError, OrgId};
use console_platform_authz::Principal;
use console_platform_db::{with_audits, with_org_conn};
use serde_json::{Value, json};
use sqlx::Postgres;
use uuid::Uuid;

use super::bulk::OPERATION;
use super::bulk_job::{
    BulkLifecycleJob, DONE, FAILED, JOB_COLUMNS, STALE_AFTER_SECS, job_from_row, progress_audit,
    update,
};
use crate::{HrError, HrService};

impl HrService {
    /// `GET /employees/lifecycle-events/bulk/jobs/{id}` (404 for another
    /// tenant's job: RLS and the org filter).
    pub async fn bulk_lifecycle_job(
        &self,
        principal: &Principal,
        id: Uuid,
    ) -> Result<BulkLifecycleJob, HrError> {
        let org = principal.org_id;
        let row = with_org_conn::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                Ok(sqlx::query(sqlx::AssertSqlSafe(format!(
                    "SELECT {JOB_COLUMNS} FROM employee_lifecycle_bulk_jobs \
                      WHERE org_id = $1 AND id = $2"
                )))
                .bind(*org.as_uuid())
                .bind(id)
                .fetch_optional(tx.as_mut())
                .await?)
            })
        })
        .await?;
        let row = row.ok_or_else(|| {
            HrError::from_kernel(KernelError::not_found(
                "bulk personnel action job not found",
            ))
        })?;
        job_from_row(&row)
    }

    /// The schedule loop's pass (any replica): a job with no step for
    /// [`STALE_AFTER_SECS`] lost its driver. Its batch either committed (the
    /// Idempotency-Key holds the response: `done`) or rolled back (`failed`
    /// `bulk_job_interrupted`: send it again). Never re-run here, so a batch
    /// is recorded at most once and only by a caller authorised at the time.
    pub async fn finish_stale_bulk_lifecycle_jobs(&self) -> Result<usize, String> {
        let orgs: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM platform_list_organizations()")
            // rls-arming: ok platform_list_organizations() is the SECURITY DEFINER id-only tenant discovery; every per-org statement below runs under with_audits
            .fetch_all(&self.pool)
            .await
            .map_err(|error| error.to_string())?;
        let mut finished = 0;
        for org_uuid in orgs {
            let org = OrgId::from_uuid(org_uuid);
            let done = with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
                Box::pin(async move { finish_stale(tx, org).await })
            })
            .await;
            match done {
                Ok(n) => finished += n,
                Err(error) => {
                    tracing::warn!(org = %org, code = error.code, "stale bulk jobs were not finished");
                }
            }
        }
        Ok(finished)
    }
}

async fn finish_stale(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: OrgId,
) -> Result<(usize, Vec<AuditEvent>), HrError> {
    let stale: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT id, idempotency_key FROM employee_lifecycle_bulk_jobs \
          WHERE org_id = $1 AND state IN ('queued', 'running') \
            AND heartbeat_at < now() - make_interval(secs => $2) \
          ORDER BY heartbeat_at LIMIT 20 FOR UPDATE SKIP LOCKED",
    )
    .bind(*org.as_uuid())
    .bind(f64::from(STALE_AFTER_SECS))
    .fetch_all(tx.as_mut())
    .await?;
    let mut audits = Vec::new();
    for (id, key) in &stale {
        let response: Option<Value> = sqlx::query_scalar(
            "SELECT response FROM api_idempotency_keys \
              WHERE org_id = $1 AND operation = $2 AND idempotency_key = $3",
        )
        .bind(*org.as_uuid())
        .bind(OPERATION)
        .bind(key)
        .fetch_optional(tx.as_mut())
        .await?
        .flatten();
        let updated = match response {
            Some(result) => {
                let total = result["items"]
                    .as_array()
                    .map_or(0, |items| i32::try_from(items.len()).unwrap_or(i32::MAX));
                update(tx, org, *id, DONE, "", |q| {
                    q.bind(None::<&str>).bind(total).bind(total).bind(result)
                })
                .await?
            }
            None => {
                let refusal = json!({
                    "code": "bulk_job_interrupted",
                    "message": "the server stopped before this 발령 was recorded; nothing was recorded, send it again",
                });
                update(tx, org, *id, FAILED, "", |q| {
                    q.bind(None::<&str>).bind(0).bind(0).bind(refusal)
                })
                .await?
            }
        };
        if let Some((job, actor)) = updated {
            audits.push(progress_audit(org, actor, &job)?);
        }
    }
    Ok((stale.len(), audits))
}
