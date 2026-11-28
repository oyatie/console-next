//! W11: the import apply job, driven inline or in the background.
//! Both paths write identical rows and audits (see `apply_job`).

use console_kernel_core::{
    AuditCommandContext, AuditSource, KernelError, OrgId, TraceContext, UserId,
};
use console_leave_adapter_postgres::PgLeaveStore;
use console_platform_authz::{Principal, cedar_pbac::actions::import_apply};
use console_platform_db::{command_context, with_audits, with_org_conn};
use serde_json::json;
use uuid::Uuid;

use crate::import::apply::{
    Checked, apply_failure, apply_support_reference, check_and_build, conflict,
    with_apply_support_reference,
};
use crate::import::apply_drive_helpers::fresh;
use crate::import::apply_job::{ApplyJob, DriverSlot, progress_audit, read_job, write_job};
use crate::import::apply_progress;
use crate::import::apply_report::final_report;
use crate::import::settle::{Chunk, SETTLE_CHUNK_ROWS, settle_chunk, settle_keys};
use crate::import::types::{EmployeeImportApplyRequest, EmployeeImportReport};
use crate::metrics::record_hr_import;
use crate::{HrError, HrService};

/// What an apply request found.
#[derive(Debug)]
pub enum Started {
    /// The run is applied and settled: its report.
    Done(EmployeeImportReport),
    /// A driver is working on it now (heartbeat fresh): nothing to start.
    Running(ApplyJob),
    /// A job to drive: new, or one whose driver died.
    Job(ApplyJob),
}

fn in_progress() -> HrError {
    conflict(
        "apply_in_progress",
        "this run is being applied; wait for it to finish",
        json!([]),
    )
}

/// 409 `apply_in_progress` while the run has a running job (a dry run would
/// replace the plan the job applies).
pub async fn refuse_while_running(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: Uuid,
    run: Uuid,
) -> Result<(), HrError> {
    match read_job(tx, org, run).await? {
        Some(job) if job.running() => Err(in_progress()),
        _ => Ok(()),
    }
}

impl HrService {
    /// Checks synchronously, then records the job for the caller to drive.
    pub async fn start_apply(
        &self,
        principal: Principal,
        run_id: Uuid,
        body: EmployeeImportApplyRequest,
    ) -> Result<Started, HrError> {
        let org = principal.org_id;
        let digest = body.dry_run_digest.trim().to_owned();
        let skip_unresolved = body.skip_unresolved;
        let rrn_vault = self.rrn_vault.clone();
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let org_uuid = *org.as_uuid();
                import_apply::require(tx, org, *principal.user_id.as_uuid())
                    .await
                    .map_err(HrError::from_kernel)?;
                crate::import::store::import_run_for_update(tx, org_uuid, run_id).await?;
                let job = read_job(tx, org_uuid, run_id).await?;
                if let Some(job) = job.as_ref().filter(|job| job.running()) {
                    if job.dry_run_digest != digest {
                        return Err(in_progress());
                    }
                    if fresh(tx, org_uuid, run_id).await? {
                        return Ok((Started::Running(job.clone()), Vec::new()));
                    }
                }
                let started = match check_and_build(
                    tx,
                    org_uuid,
                    run_id,
                    &digest,
                    skip_unresolved,
                    rrn_vault.as_deref(),
                )
                .await?
                {
                    Checked::Replay(report) => match job {
                        Some(job) if job.state == "done" => {
                            return Ok((Started::Done(job.report.unwrap_or(report)), Vec::new()));
                        }
                        // Applied before jobs or with settle unfinished: finish it.
                        _ => ApplyJob {
                            state: "settling".into(),
                            skip_unresolved,
                            ..ApplyJob::queued(run_id, &digest, principal.user_id)
                        },
                    },
                    Checked::Apply(_) => ApplyJob {
                        total: settle_keys(tx, org, run_id).await?.len(),
                        skip_unresolved,
                        ..ApplyJob::queued(run_id, &digest, principal.user_id)
                    },
                };
                apply_progress::reset(tx, org_uuid, &started).await?;
                write_job(tx, org_uuid, &started).await?;
                let audit = progress_audit(org, &started)?;
                Ok((Started::Job(started), vec![audit]))
            })
        })
        .await
    }

    /// The run's job (`GET …/apply`); 404 if no apply was started.
    pub async fn apply_job(&self, org: OrgId, run_id: Uuid) -> Result<ApplyJob, HrError> {
        with_org_conn::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                match read_job(tx, *org.as_uuid(), run_id).await? {
                    Some(job) => apply_progress::overlay(tx, *org.as_uuid(), job)
                        .await
                        .map(Some),
                    None => Ok(None),
                }
            })
        })
        .await?
        .ok_or_else(|| {
            HrError::from_kernel(KernelError::not_found("no apply was started for this run"))
        })
    }

    /// Drives to `done` or `failed`; without a leave store only settle can run.
    /// An unfinished leave command fails `apply_interrupted` (re-send it).
    pub async fn drive_apply(
        &self,
        command_store: Option<PgLeaveStore>,
        org: OrgId,
        run_id: Uuid,
    ) -> Result<EmployeeImportReport, HrError> {
        let job = with_org_conn::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move { read_job(tx, *org.as_uuid(), run_id).await })
        })
        .await?
        .ok_or_else(|| {
            HrError::from_kernel(KernelError::not_found("no apply was started for this run"))
        })?;
        let mut context = AuditCommandContext::for_actor(Some(UserId::from_uuid(job.requested_by)));
        context.org_id = Some(org);
        context.source = AuditSource::Import;
        context.scope_ids = vec![*org.as_uuid()];
        // Inline work keeps its lease; detached job transactions have no lease.
        with_apply_support_reference(
            apply_support_reference(),
            command_context::scope_execution(
                context,
                command_context::execution(),
                self.drive_job(command_store, org, job),
            ),
        )
        .await
    }

    async fn drive_job(
        &self,
        command_store: Option<PgLeaveStore>,
        org: OrgId,
        mut job: ApplyJob,
    ) -> Result<EmployeeImportReport, HrError> {
        let run_id = job.run_id;
        let actor = UserId::from_uuid(job.requested_by);
        job.state = "applying".into();
        self.save_apply_job(org, &job).await?;
        let failure_job = job.clone();
        let capability = match command_store {
            Some(store) => console_platform_request_context::scope_org(
                org,
                store.employee_import_capability(run_id, actor),
            )
            .await
            .map_err(apply_failure),
            None => Ok(None),
        };
        let capability = match capability {
            Ok(token) => token,
            Err(error) => return Err(self.fail_apply_job(org, failure_job, error).await),
        };
        let progress_pool = self.pool.clone();
        let rrn_vault = self.rrn_vault.clone();
        let applied = with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                import_apply::require(tx, org, *actor.as_uuid()).await.map_err(HrError::from_kernel)?;
                match check_and_build(
                    tx,
                    *org.as_uuid(),
                    run_id,
                    &job.dry_run_digest,
                    job.skip_unresolved,
                    rrn_vault.as_deref(),
                )
                .await?
                {
                    Checked::Replay(_) => {
                        if let Some(done) = read_job(tx, *org.as_uuid(), run_id).await?
                            && done.state == "done"
                            && let Some(report) = done.report {
                            return Ok((report, Vec::new()));
                        }
                    }
                    Checked::Apply(rows) => {
                        if capability.is_none() {
                            return Err(conflict("apply_interrupted", "the apply stopped before it wrote anything; send it again", json!([])));
                        }
                        let trace = TraceContext::generate();
                        sqlx::query("SELECT * FROM import_api.apply_employee_import_batch($1,$2,$3,$4,$5,$6,$7,$8,$9)")
                            .bind(org.as_uuid()).bind(run_id).bind(format!("run:{run_id}"))
                            .bind(rows).bind(actor.as_uuid())
                            .bind(json!({"run_id": run_id, "entity_type": "employee_hr", "dry_run_digest": job.dry_run_digest}))
                            .bind(trace.trace_id()).bind(trace.span_id())
                            .bind(capability)
                            .execute(tx.as_mut()).await
                            .map_err(|error| apply_failure(console_leave_adapter_postgres::PgLeaveError::from(error)))?;
                    }
                }
                let keys = settle_keys(tx, org, run_id).await?;
                let report = final_report(tx, org, run_id).await?;
                job.total = keys.len();
                let count = keys.len().div_ceil(SETTLE_CHUNK_ROWS).max(1);
                for i in 0..count {
                    let end = keys.len().min((i + 1) * SETTLE_CHUNK_ROWS);
                    job.done = end;
                    let last = i + 1 == count;
                    job.state = if last { "done" } else { "settling" }.into();
                    job.report = last.then(|| report.clone());
                    let chunk = Chunk {
                        keys: &keys[i * SETTLE_CHUNK_ROWS..end],
                        last,
                        job: Some(job.clone()),
                    };
                    settle_chunk(org, actor, run_id, chunk, rrn_vault.clone())(tx).await?;
                    if !last
                        && let Err(error) = apply_progress::publish(&progress_pool, org, job.clone()).await
                    {
                        tracing::warn!(org = %org, run = %run_id, code = error.code, "import apply progress could not be published");
                        metrics::counter!("hr_import_apply_progress_failures_total").increment(1);
                    }
                }
                let report = read_job(tx, *org.as_uuid(), run_id).await?
                    .and_then(|job| job.report)
                    .ok_or_else(|| HrError::internal("completed import has no report"))?;
                Ok((report, Vec::new()))
            })
        }).await;
        let report = match applied {
            Ok(report) => report,
            Err(error) => return Err(self.fail_apply_job(org, failure_job, error).await),
        };
        crate::import::statistics::refresh_after_apply(&self.pool, org, report.inserted).await;
        record_hr_import(report.inserted, report.updated);
        metrics::counter!("hr_data_import_runs_total", "stage" => "apply").increment(1);
        Ok(report)
    }

    /// The synchronous apply (no `Prefer: respond-async`): the same job,
    /// driven inline. A replay of an applied run returns its report.
    ///
    /// # Errors
    /// Every refusal of [`Self::start_apply`], 409 `apply_in_progress` while
    /// another driver runs the job, 503 `import_apply_busy`.
    pub async fn apply_import(
        &self,
        principal: Principal,
        command_store: PgLeaveStore,
        run_id: Uuid,
        body: EmployeeImportApplyRequest,
    ) -> Result<EmployeeImportReport, HrError> {
        let org = principal.org_id;
        let _slot = DriverSlot::take()?;
        match self.start_apply(principal, run_id, body).await? {
            Started::Done(report) => Ok(report),
            Started::Running(_) => Err(in_progress()),
            Started::Job(_) => self.drive_apply(Some(command_store), org, run_id).await,
        }
    }
}
