// SPDX-License-Identifier: LicenseRef-Proprietary
//! Durable rollback commands; the inverse and its completion commit in one locked transaction.

use super::{Loaded, RollbackOutcome, check_digest, event, execute, plan};
use crate::import::apply_job::DriverSlot;
use crate::{HrError, HrService};
use console_kernel_core::OrgId;
use console_platform_authz::Principal;
use console_platform_db::{with_audits, with_org_conn};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize)]
pub struct RollbackJobStatus {
    pub state: String,
    pub total: usize,
    pub error: Option<Value>,
}

#[derive(Serialize, Deserialize)]
struct Command {
    #[serde(flatten)]
    status: RollbackJobStatus,
    principal: Principal,
    digest: String,
    mode: String,
    reason: String,
    note: Option<String>,
    requested_by: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339")]
    filed_at: OffsetDateTime,
    review: bool,
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn enqueue(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    run: Uuid,
    loaded: &Loaded,
    reason: &str,
    note: Option<&str>,
    requested: Option<(Uuid, OffsetDateTime)>,
    review: bool,
) -> Result<(RollbackOutcome, Vec<console_kernel_core::AuditEvent>), HrError> {
    let now = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(tx.as_mut())
        .await?;
    let command = Command {
        status: RollbackJobStatus {
            state: "queued".into(),
            total: loaded.preview.rows.len(),
            error: None,
        },
        mode: loaded.preview.mode.to_owned(),
        principal: principal.clone(),
        digest: loaded.preview.preview_digest.clone(),
        reason: reason.to_owned(),
        note: note.map(str::to_owned),
        requested_by: requested.map(|r| r.0),
        filed_at: requested.map_or(now, |r| r.1),
        review,
    };
    write(tx, principal.org_id, run, &command).await?;
    let audit = event(
        principal,
        run,
        "data_import.rollback.progress",
        json!({"state":"queued","total":command.status.total}),
    )?;
    Ok((
        RollbackOutcome {
            run_id: run,
            status: "ROLLBACK_RUNNING".into(),
            request_id: None,
            review_required: review,
            rolled_back_at: None,
        },
        vec![audit],
    ))
}

async fn write(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    run: Uuid,
    command: &Command,
) -> Result<(), HrError> {
    sqlx::query("UPDATE data_import_runs SET rollback_job=$3 WHERE org_id=$1 AND id=$2")
        .bind(org.as_uuid())
        .bind(run)
        .bind(json!(command))
        .execute(tx.as_mut())
        .await?;
    Ok(())
}

impl HrService {
    pub fn spawn_import_rollback(self, org: OrgId, run: Uuid, slot: DriverSlot) {
        tokio::spawn(async move {
            let _slot = slot;
            if let Err(error) = self.drive_import_rollback_locked(org, run).await {
                tracing::warn!(%run, code=error.code, "import rollback job stopped");
            }
        });
    }

    pub async fn drive_import_rollback(&self, org: OrgId, run: Uuid) -> Result<(), HrError> {
        let _slot = DriverSlot::take()?;
        self.drive_import_rollback_locked(org, run).await
    }

    async fn drive_import_rollback_locked(&self, org: OrgId, run: Uuid) -> Result<(), HrError> {
        let start = std::time::Instant::now();
        let result = with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                // Holding the run lock through commit also makes restart recovery safe across replicas.
                let stored: Option<Value> = sqlx::query_scalar(
                    "SELECT rollback_job FROM data_import_runs WHERE org_id=$1 AND id=$2 \
                 AND status='APPLIED' AND rollback_job->>'state'='queued' FOR UPDATE SKIP LOCKED",
                )
                .bind(org.as_uuid())
                .bind(run)
                .fetch_optional(tx.as_mut())
                .await?;
                let Some(stored) = stored else {
                    return Ok(((), vec![]));
                };
                let mut command: Command = serde_json::from_value(stored)
                    .map_err(|_| HrError::internal("stored rollback job is unreadable"))?;
                let loaded = plan::load(
                    tx,
                    &command.principal,
                    run,
                    Some((run, command.filed_at)),
                    true,
                )
                .await?;
                if loaded.preview.mode != command.mode {
                    return Err(super::coded("rows_changed_since_preview"));
                }
                check_digest(&loaded.preview, &command.digest)?;
                let (_, audits) = execute::apply(
                    tx,
                    &command.principal,
                    run,
                    &loaded,
                    &command.reason,
                    command.note.as_deref(),
                    command.requested_by,
                    command.review,
                )
                .await?;
                command.status.state = "done".into();
                write(tx, org, run, &command).await?;
                Ok(((), audits))
            })
        })
        .await;
        crate::metrics::record_import_rollback("rollback", start.elapsed().as_secs_f64());
        if let Err(error) = &result {
            let error = json!({"status":error.status.as_u16(),"code":error.code,"message":error.message,"refusals":error.refusals});
            with_audits::<_, _, HrError>(&self.pool, org, move |tx| Box::pin(async move {
                let stored: Option<Value> = sqlx::query_scalar(
                    "SELECT rollback_job FROM data_import_runs WHERE org_id=$1 AND id=$2 \
                     AND status='APPLIED' AND rollback_job->>'state'='queued' FOR UPDATE SKIP LOCKED")
                    .bind(org.as_uuid()).bind(run).fetch_optional(tx.as_mut()).await?;
                let Some(stored) = stored else { return Ok(((), vec![])); };
                let mut command: Command = serde_json::from_value(stored)
                    .map_err(|_| HrError::internal("stored rollback job is unreadable"))?;
                command.status.state = "failed".into();
                command.status.error = Some(error);
                write(tx, org, run, &command).await?;
                let audit = event(&command.principal, run, "data_import.rollback.progress",
                    json!({"state":"failed","error":command.status.error.as_ref().map(|e| &e["code"])}))?;
                Ok(((), vec![audit]))
            })).await?;
        }
        result
    }

    /// Queued work survives process loss; locked live jobs are skipped by each replica.
    pub async fn resume_import_rollbacks(&self) -> Result<usize, HrError> {
        let orgs: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM platform_list_organizations()")
            // rls-arming: ok id-only tenant discovery; each run below uses with_org_conn.
            .fetch_all(&self.pool)
            .await?;
        let mut count = 0;
        for org in orgs {
            let org = OrgId::from_uuid(org);
            let runs: Vec<Uuid> = with_org_conn::<_, _, HrError>(&self.pool, org, move |tx| Box::pin(async move {
                Ok(sqlx::query_scalar("SELECT id FROM data_import_runs WHERE org_id=$1 AND entity_type='employee_hr' \
                    AND status='APPLIED' AND rollback_job->>'state'='queued'")
                    .bind(org.as_uuid()).fetch_all(tx.as_mut()).await?)
            })).await?;
            for run in runs {
                self.drive_import_rollback(org, run).await?;
                count += 1;
            }
        }
        Ok(count)
    }
}
