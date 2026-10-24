//! `worker` role: the dispatch worker and evidence transcoding jobs, and the
//! periodic loops. A loop whose module is compiled out (docs/ops/mvp-build.md)
//! does not run.

use crate::audit_chain_signer;
use crate::config::AppConfig;
use crate::config::DEFAULT_SERVICE_NAME;
use crate::error::AppError;
#[cfg(feature = "facilities")]
use crate::facilities_schedule;
use crate::http::metrics::install_metrics_recorder;
use crate::http::metrics::with_metrics;
use crate::http::ops::healthz;
use crate::http::ops::readyz;
use crate::lifecycle_schedule;
use crate::run::shutdown::shutdown_signal;
use crate::state::AppState;
use crate::state::DatabaseDependency;
#[cfg(feature = "workorder")]
use crate::workflow_drain;
#[cfg(feature = "workspace")]
use crate::workflow_schedules;
use axum::Router;
use axum::routing::get;
#[cfg(feature = "dispatch")]
use console_dispatch_adapter_postgres::PgDispatchStore;
#[cfg(feature = "dispatch")]
use console_dispatch_worker::{AlimtalkEscalationPolicy, DispatchWorker};
use console_kernel_core::{EvidenceId, OrgId, TraceContext};
use console_platform_jobs::{
    BoxFuture, JobQueueError, PlatformJob, PlatformJobHandler, run_apalis_worker_until_shutdown,
};
use console_platform_storage::{
    EvidenceService, FfmpegMediaProcessor, SeaweedS3Storage, StorageError,
};
use std::env;
use std::sync::Arc;

pub(crate) async fn run_dispatch_worker(
    config: AppConfig,
    state: AppState,
) -> Result<(), AppError> {
    install_metrics_recorder()?;
    let database_url = config
        .database_url
        .as_deref()
        .ok_or_else(|| AppError::Config("worker role requires DATABASE_URL".to_owned()))?;
    let pool = match &state.database {
        DatabaseDependency::Postgres(pool) => pool.clone(),
        DatabaseDependency::NotConfigured => {
            return Err(AppError::Config(
                "worker role requires a configured database".to_owned(),
            ));
        }
    };
    tracing::info!(
        service = %config.service_name,
        role = %config.role,
        queue = "console.dispatch",
        "starting console-app worker"
    );
    // M2 workflow-runtime payroll outbox drainer (design §B/§F). Runs alongside
    // the apalis dispatch worker on the same `console_rt` pool, re-arming
    // `app.current_org` per tenant each tick. Lands dark: no tenant is enrolled in
    // a shipped migration/seed, so it finds no work in production.
    #[cfg(feature = "workorder")]
    let workflow_drain_handle = workflow_drain::spawn(pool.clone());
    // L20 tamper-evident audit-chain seal worker (charter §5.1). Seals batches of
    // audit_events into the append-only audit_chain_seals hash chain on the same
    // `console_rt` pool, re-arming `app.current_org` per tenant each tick.
    // Production path: ExternalSealSigner + HTTP SealSignTransport to an
    // out-of-process custody daemon (console-ae5 wiring). Without custody config
    // the worker fails closed unless CONSOLE_AUDIT_CHAIN_ALLOW_DEV_SIGNER=true.
    // The attestation REST endpoint reads whatever is sealed regardless of this
    // gate. Default OFF.
    let audit_chain_handle = if config.audit_chain_seal_enabled {
        match audit_chain_signer::build_seal_worker_signer(
            config.audit_chain_external.as_ref(),
            config.audit_chain_allow_dev_signer,
        ) {
            Ok(Some(signer)) => {
                tracing::info!(
                    key_ref = %signer.key_ref(),
                    external = config.audit_chain_external.is_some(),
                    "starting audit-chain seal worker"
                );
                Some(console_platform_audit_chain::spawn(pool.clone(), signer))
            }
            Ok(None) => None,
            Err(err) => {
                tracing::error!(error = %err, "audit-chain signer init failed; seal worker not started");
                None
            }
        }
    } else {
        tracing::info!(
            "CONSOLE_AUDIT_CHAIN_SEAL_ENABLED is not set; the audit-chain seal worker is OFF"
        );
        None
    };
    // Workflow cron-schedule poller (BE-AUTO slice 1). Same worker-role,
    // per-tenant re-armed loop shape as the drainer. Dark-safe: no shipped
    // migration/seed creates a schedule row, so it finds no work until a tenant
    // authors one through the audited studio REST surface.
    #[cfg(feature = "workspace")]
    let workflow_schedule_handle = workflow_schedules::spawn(pool.clone());
    #[cfg(feature = "facilities")]
    let facilities_schedule_handle = facilities_schedule::spawn(pool.clone());
    let lifecycle_schedule_handle =
        lifecycle_schedule::spawn(pool.clone(), true, state.nts.clone());
    #[cfg(feature = "dispatch")]
    let dispatch_worker = DispatchWorker::new(
        PgDispatchStore::new(pool),
        state.push_notifier.clone(),
        if config.solapi.is_some() {
            AlimtalkEscalationPolicy::enabled()
        } else {
            AlimtalkEscalationPolicy::disabled()
        },
    );
    #[cfg(not(feature = "dispatch"))]
    drop(pool);
    // Compose the dispatch-timer worker with the evidence-transcode handler so a
    // SINGLE apalis worker on the `console.dispatch` queue services both job
    // families. EvidenceTranscode is routed to the transcode handler (which owns
    // the EvidenceService + ffmpeg processor + a concurrency cap); everything
    // else falls through to the dispatch worker.
    let evidence_worker = state.evidence_storage.clone().map(|service| {
        EvidenceTranscodeWorker::new(service, config.evidence_transcode_concurrency)
    });
    if evidence_worker.is_none() {
        tracing::warn!(
            "evidence storage is not configured; evidence transcode jobs will be rejected"
        );
    }
    let worker = CompositeJobHandler {
        #[cfg(feature = "dispatch")]
        dispatch: dispatch_worker,
        evidence: evidence_worker,
    };

    // The worker exposes no API surface, but orchestrators (Compose/K8s) still
    // need a liveness/readiness probe. Serve /healthz + /readyz on the same
    // address the API role uses, concurrently with the apalis worker.
    let health_listener = tokio::net::TcpListener::bind(config.http_addr)
        .await
        .map_err(AppError::Io)?;
    tracing::info!(addr = %config.http_addr, "worker health server listening");
    let health_router = with_metrics(
        Router::new()
            .route("/healthz", get(healthz))
            .route("/readyz", get(readyz))
            .with_state(state.clone()),
        &state,
    );
    let health_server = tokio::spawn(async move {
        if let Err(err) = axum::serve(health_listener, health_router).await {
            tracing::warn!(error = %err, "worker health server stopped");
        }
    });
    let internal = crate::run::serve::spawn_internal_listener(&state).await?;

    // Kubernetes sets this explicitly via the Downward API in worker.yaml. Do
    // not use generic HOSTNAME: Docker/local shells often set it too, and those
    // environments should keep the stable service-name-only worker identity.
    let pod_name = env::var("CONSOLE_POD_NAME").ok();
    let worker_name = dispatch_apalis_worker_name(&config.service_name, pod_name.as_deref());
    let result = run_apalis_worker_until_shutdown(
        database_url,
        console_platform_jobs::status::DISPATCH_QUEUE,
        worker_name,
        worker,
        shutdown_signal(config.shutdown_timeout, state.clone()),
    )
    .await
    .map_err(|err| AppError::Worker(err.to_string()));

    #[cfg(feature = "workorder")]
    workflow_drain_handle.shutdown();
    if let Some(handle) = audit_chain_handle {
        handle.shutdown();
    }
    #[cfg(feature = "workspace")]
    workflow_schedule_handle.shutdown();
    #[cfg(feature = "facilities")]
    facilities_schedule_handle.shutdown();
    lifecycle_schedule_handle.shutdown();
    health_server.abort();
    if let Some(internal) = internal {
        internal.abort();
    }
    result
}

fn dispatch_apalis_worker_name(service_name: &str, pod_name: Option<&str>) -> String {
    let service_name = service_name.trim();
    let service_name = if service_name.is_empty() {
        DEFAULT_SERVICE_NAME
    } else {
        service_name
    };
    match pod_name.map(str::trim).filter(|value| !value.is_empty()) {
        Some(pod_name) => format!("{service_name}-{pod_name}-dispatch-worker"),
        None => format!("{service_name}-dispatch-worker"),
    }
}

/// Routes apalis jobs on the shared `console.dispatch` queue: `EvidenceTranscode`
/// goes to the evidence handler, everything else to the dispatch-timer worker
/// (refused when the dispatch module is compiled out; nothing enqueues one then).
struct CompositeJobHandler {
    #[cfg(feature = "dispatch")]
    dispatch: DispatchWorker,
    evidence: Option<EvidenceTranscodeWorker>,
}

impl PlatformJobHandler for CompositeJobHandler {
    fn handle<'a>(&'a self, job: PlatformJob) -> BoxFuture<'a, Result<(), JobQueueError>> {
        Box::pin(async move {
            match job {
                PlatformJob::EvidenceTranscode(evidence_job) => match &self.evidence {
                    Some(worker) => {
                        worker
                            .handle(evidence_job.org_id, evidence_job.evidence_id)
                            .await
                    }
                    None => Err(JobQueueError::Worker(
                        "evidence storage is not configured for transcode jobs".to_owned(),
                    )),
                },
                // Delegate via the PlatformJobHandler impl so the dispatch
                // worker's error is mapped into JobQueueError.
                #[cfg(feature = "dispatch")]
                other => PlatformJobHandler::handle(&self.dispatch, other).await,
                #[cfg(not(feature = "dispatch"))]
                other => Err(JobQueueError::Worker(format!(
                    "the dispatch module is not in this build: {other:?}"
                ))),
            }
        })
    }
}

/// Background handler that transcodes/optimizes a staged evidence original into
/// the final 1080p/recompressed deliverable. Arms `app.current_org` to the job's
/// tenant (RLS), claims the pending row, runs ffmpeg/image processing behind a
/// concurrency cap (backpressure), and transitions PROCESSING → READY/FAILED.
struct EvidenceTranscodeWorker {
    service: EvidenceService<SeaweedS3Storage>,
    processor: FfmpegMediaProcessor,
    permits: Arc<tokio::sync::Semaphore>,
}

impl EvidenceTranscodeWorker {
    fn new(service: EvidenceService<SeaweedS3Storage>, concurrency: usize) -> Self {
        let concurrency = concurrency.max(1);
        Self {
            service,
            processor: FfmpegMediaProcessor::default(),
            permits: Arc::new(tokio::sync::Semaphore::new(concurrency)),
        }
    }

    async fn handle(&self, org: OrgId, evidence_id: EvidenceId) -> Result<(), JobQueueError> {
        // Backpressure: cap the number of concurrent transcodes regardless of how
        // many jobs apalis hands us, so a burst of uploads can't exhaust CPU/disk.
        let _permit = self
            .permits
            .acquire()
            .await
            .map_err(|err| JobQueueError::Worker(err.to_string()))?;
        // Arm the tenant from the job payload BEFORE any RLS-gated work; the
        // EvidenceService reads/writes the staging + status rows under this org.
        console_platform_request_context::scope_org(org, async { self.process(evidence_id).await })
            .await
            .map_err(|err| JobQueueError::Worker(err.to_string()))
    }

    async fn process(&self, evidence_id: EvidenceId) -> Result<(), StorageError> {
        let Some(job) = self.service.claim_processing_job().await? else {
            // Already processed (READY/FAILED) or claimed by another worker —
            // idempotent no-op.
            tracing::info!(
                %evidence_id,
                "evidence transcode: no pending row to claim (already processed)"
            );
            return Ok(());
        };
        let status = self
            .service
            .process_job(
                &self.processor,
                &job,
                TraceContext::generate(),
                time::OffsetDateTime::now_utc(),
            )
            .await?;
        tracing::info!(
            media_id = %job.media_id,
            work_order_id = %job.work_order_id,
            status = status.as_db_str(),
            "evidence transcode complete"
        );
        Ok(())
    }
}

#[cfg(test)]
#[cfg(not(feature = "test-postgres"))]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod worker_identity_tests {
    use super::dispatch_apalis_worker_name;
    use crate::config::DEFAULT_SERVICE_NAME;

    #[test]
    fn dispatch_worker_name_includes_pod_hostname_when_present() {
        let name = dispatch_apalis_worker_name("console-app-worker", Some("console-worker-abc123"));

        assert_eq!(
            name,
            "console-app-worker-console-worker-abc123-dispatch-worker"
        );
    }

    #[test]
    fn dispatch_worker_name_falls_back_to_service_name_outside_kubernetes() {
        let name = dispatch_apalis_worker_name("console-app-worker", None);

        assert_eq!(name, "console-app-worker-dispatch-worker");
    }

    #[test]
    fn dispatch_worker_name_ignores_empty_hostname() {
        let name = dispatch_apalis_worker_name("console-app-worker", Some("   "));

        assert_eq!(name, "console-app-worker-dispatch-worker");
    }

    #[test]
    fn dispatch_worker_name_uses_default_service_for_empty_service_name() {
        let name = dispatch_apalis_worker_name(" ", Some("pod-1"));

        assert_eq!(
            name,
            format!("{DEFAULT_SERVICE_NAME}-pod-1-dispatch-worker")
        );
    }
}
