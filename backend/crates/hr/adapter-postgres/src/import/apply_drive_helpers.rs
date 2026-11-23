// SPDX-License-Identifier: LicenseRef-Proprietary
//! Helper methods split from `apply_drive.rs` to stay under the file-size cap.

use console_kernel_core::OrgId;
use console_platform_db::with_audits;
use uuid::Uuid;

use crate::import::apply::apply_support_reference;
use crate::import::apply_job::{ApplyJob, STALE_AFTER_SECS, progress_audit, read_job, write_job};
use crate::import::apply_progress;
use crate::{HrError, HrService};

pub(super) async fn fresh(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: Uuid,
    run: Uuid,
) -> Result<bool, HrError> {
    Ok(sqlx::query_scalar(
        "SELECT COALESCE(apply_heartbeat_at > now() - make_interval(secs => $3), false) \
           FROM data_import_runs WHERE org_id = $1 AND id = $2",
    )
    .bind(org)
    .bind(run)
    .bind(f64::from(STALE_AFTER_SECS))
    .fetch_one(tx.as_mut())
    .await?)
}

impl HrService {
    pub(super) async fn save_apply_job(&self, org: OrgId, job: &ApplyJob) -> Result<(), HrError> {
        let job = job.clone();
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                sqlx::query("SELECT 1 FROM data_import_runs WHERE org_id=$1 AND id=$2 FOR UPDATE")
                    .bind(org.as_uuid())
                    .bind(job.run_id)
                    .execute(tx.as_mut())
                    .await?;
                if read_job(tx, *org.as_uuid(), job.run_id)
                    .await?
                    .is_some_and(|stored| stored.state == "done")
                {
                    return Ok(((), Vec::new()));
                }
                if job.state == "applying" {
                    apply_progress::reset(tx, *org.as_uuid(), &job).await?;
                }
                write_job(tx, *org.as_uuid(), &job).await?;
                let audit = progress_audit(org, &job)?;
                Ok(((), vec![audit]))
            })
        })
        .await
    }

    pub(super) async fn fail_apply_job(
        &self,
        org: OrgId,
        job: ApplyJob,
        error: HrError,
    ) -> HrError {
        let support_ref = apply_support_reference();
        if error.status.is_server_error() && error.status != http::StatusCode::SERVICE_UNAVAILABLE {
            tracing::error!(%support_ref, code = error.code, detail = %error.message, "import apply job failed");
        } else {
            tracing::warn!(%support_ref, code = error.code, detail = %error.message, "import apply job failed");
        }
        if let Err(stored) = self.save_apply_job(org, &job.failed(&error)).await {
            tracing::warn!(error = %stored.message, "import apply job failure could not be stored");
        }
        error
    }
}
