//! W11: the schedule loop's resume of apply jobs whose driver died (any
//! replica; the claim is `SKIP LOCKED` and audited like every job step).

use console_kernel_core::OrgId;
use console_platform_db::with_audits;
use uuid::Uuid;

use crate::import::apply_job::{ApplyJob, DriverSlot, STALE_AFTER_SECS, progress_audit};
use crate::{HrError, HrService};

impl HrService {
    /// The schedule loop's pass: every job whose driver stopped writing for
    /// [`STALE_AFTER_SECS`] is claimed (`SKIP LOCKED`, any replica) and driven
    /// as far as it can be without the leave command. Returns jobs driven.
    pub async fn resume_stale_applies(&self) -> Result<usize, String> {
        let pool = &self.pool;
        let orgs: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM platform_list_organizations()")
            // rls-arming: ok platform_list_organizations() is the SECURITY DEFINER id-only tenant discovery; every per-org statement below runs under with_org_conn
            .fetch_all(pool)
            .await
            .map_err(|error| error.to_string())?;
        let mut driven = 0;
        for org_uuid in orgs {
            let org = OrgId::from_uuid(org_uuid);
            // The claim is audited like every job step (the run's realtime
            // event says it resumed).
            let claimed = with_audits::<_, _, HrError>(pool, org, move |tx| {
                Box::pin(async move {
                    let jobs: Vec<serde_json::Value> = sqlx::query_scalar(
                        "UPDATE data_import_runs SET apply_heartbeat_at = now() \
                          WHERE org_id = $1 AND id IN ( \
                            SELECT id FROM data_import_runs \
                             WHERE org_id = $1 \
                               AND apply_job->>'state' IN ('queued', 'applying', 'settling') \
                               AND apply_heartbeat_at < now() - make_interval(secs => $2) \
                             ORDER BY apply_heartbeat_at LIMIT 5 FOR UPDATE SKIP LOCKED) \
                         RETURNING apply_job",
                    )
                    .bind(org_uuid)
                    .bind(f64::from(STALE_AFTER_SECS))
                    .fetch_all(tx.as_mut())
                    .await?;
                    let jobs: Vec<ApplyJob> = jobs
                        .into_iter()
                        .filter_map(|job| serde_json::from_value(job).ok())
                        .collect();
                    let audits = jobs
                        .iter()
                        .map(|job| progress_audit(org, job))
                        .collect::<Result<Vec<_>, _>>()?;
                    Ok((
                        jobs.into_iter().map(|job| job.run_id).collect::<Vec<_>>(),
                        audits,
                    ))
                })
            })
            .await;
            let runs = match claimed {
                Ok(runs) => runs,
                Err(error) => {
                    tracing::warn!(org = %org, error = %error.message, "stale import applies could not be listed");
                    continue;
                }
            };
            for run in runs {
                let Ok(_slot) = DriverSlot::take() else {
                    return Ok(driven);
                };
                driven += 1;
                if let Err(error) = self.drive_apply(None, org, run).await {
                    tracing::info!(org = %org, run = %run, code = error.code, "resumed import apply stopped");
                }
            }
        }
        Ok(driven)
    }
}
