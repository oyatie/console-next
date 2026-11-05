// SPDX-License-Identifier: LicenseRef-Proprietary
//! Counts only: published separately while the employee writes remain atomic.
use console_kernel_core::{AuditCommandContext, AuditSource, OrgId, UserId};
use console_platform_db::{command_context, with_audits};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::HrError;
use crate::import::apply_job::{ApplyJob, progress_audit};

pub(super) async fn reset(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    job: &ApplyJob,
) -> Result<(), HrError> {
    // Create before the apply holds the run lock: publication never needs a foreign-key lock.
    sqlx::query(
        "INSERT INTO import_apply_progress(org_id,run_id,done,total) VALUES($1,$2,0,$3)
         ON CONFLICT(org_id,run_id) DO UPDATE SET done=0,total=EXCLUDED.total,updated_at=now()",
    )
    .bind(org)
    .bind(job.run_id)
    .bind(job.total as i64)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

pub(super) async fn publish(pool: &PgPool, org: OrgId, job: ApplyJob) -> Result<(), HrError> {
    let mut context = AuditCommandContext::for_actor(Some(UserId::from_uuid(job.requested_by)));
    context.org_id = Some(org);
    context.source = AuditSource::Import;
    // Progress must not acquire or settle the parent command's idempotency lock.
    command_context::scope(
        context,
        with_audits::<_, _, HrError>(pool, org, move |tx| {
            Box::pin(async move {
                sqlx::query(
                    "UPDATE import_apply_progress SET done=$3,total=$4,updated_at=now()
                 WHERE org_id=$1 AND run_id=$2",
                )
                .bind(org.as_uuid())
                .bind(job.run_id)
                .bind(job.done as i64)
                .bind(job.total as i64)
                .execute(tx.as_mut())
                .await?;
                Ok(((), vec![progress_audit(org, &job)?]))
            })
        }),
    )
    .await
}

pub(super) async fn overlay(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    mut job: ApplyJob,
) -> Result<ApplyJob, HrError> {
    if matches!(job.state.as_str(), "queued" | "applying") {
        let progress: Option<(i64, i64)> = sqlx::query_as(
            "SELECT done,total FROM import_apply_progress WHERE org_id=$1 AND run_id=$2",
        )
        .bind(org)
        .bind(job.run_id)
        .fetch_optional(tx.as_mut())
        .await?;
        if let Some((done, total)) = progress {
            job.done = done as usize;
            job.total = total as usize;
            if done > 0 {
                job.state = "settling".into();
            }
        }
    }
    Ok(job)
}
