use super::{AuditContext, StartRunRequest, run_audit_event};
use console_kernel_core::{ErrorKind, KernelError};
use console_workflow_domain::{
    NewRun, RunRecord, RunStatus, RunTransition, WorkflowRuntimePort, validate_run_transition,
};
use serde_json::json;
use uuid::Uuid;

/// Start a run: INSERT `workflow_runs` STARTING, then advance STARTING→RUNNING.
/// Both writes are audited by the port. Returns the run id.
pub async fn start_run<P: WorkflowRuntimePort + ?Sized>(
    port: &P,
    request: StartRunRequest,
    audit: &AuditContext,
) -> Result<Uuid, KernelError> {
    start_run_owned(port, request, audit)
        .await
        .map_err(|failure| failure.error)
}

pub(crate) struct StartFailure {
    pub error: KernelError,
    pub inserted: bool,
}
impl From<KernelError> for StartFailure {
    fn from(error: KernelError) -> Self {
        Self {
            error,
            inserted: false,
        }
    }
}

pub(crate) async fn start_run_owned<P: WorkflowRuntimePort + ?Sized>(
    port: &P,
    request: StartRunRequest,
    audit: &AuditContext,
) -> Result<Uuid, StartFailure> {
    // A run is born STARTING and immediately advances to RUNNING; validate the
    // edge up front so an illegal FSM table never reaches the DB.
    validate_run_transition(RunStatus::Starting, RunStatus::Running)?;

    let run_id = request.run_id;
    let org = request.org_id;
    let expected = RunRecord {
        id: run_id,
        org_id: org,
        status: RunStatus::Starting,
        definition_id: request.definition_id,
        definition_version: request.definition_version,
        object_type: request.object_type.clone(),
        object_id: request.object_id,
    };
    let new_run = NewRun {
        id: run_id,
        org_id: org,
        definition_id: request.definition_id,
        definition_version: request.definition_version,
        trigger_type: request.trigger_type,
        object_type: request.object_type,
        object_id: request.object_id,
        idempotency_key: request.idempotency_key,
        correlation_id: request.correlation_id,
        trace_id: request.trace_id,
        input_payload: request.input_payload,
        context_payload: request.context_payload,
        initiated_by: request.initiated_by,
        schedule_id: request.schedule_id,
    };

    let insert_audit = run_audit_event(
        "workflow_run.start",
        audit,
        run_id,
        org,
        None,
        Some(json!({ "status": RunStatus::Starting.as_db_str() })),
    )?;
    port.insert_run(new_run, insert_audit).await?;

    let transition = RunTransition {
        run_id,
        from: RunStatus::Starting,
        to: RunStatus::Running,
        output_payload: None,
        error_payload: None,
    };
    let transition_audit = run_audit_event(
        "workflow_run.transition",
        audit,
        run_id,
        org,
        Some(json!({ "status": RunStatus::Starting.as_db_str() })),
        Some(json!({ "status": RunStatus::Running.as_db_str() })),
    )?;
    if let Err(error) = port.transition_run(org, transition, transition_audit).await {
        recover_started_status(port, &expected, error)
            .await
            .map_err(|error| StartFailure {
                error,
                inserted: true,
            })?;
    }

    Ok(run_id)
}

pub(crate) async fn recover_started_status<P: WorkflowRuntimePort + ?Sized>(
    port: &P,
    expected: &RunRecord,
    error: KernelError,
) -> Result<RunStatus, KernelError> {
    if error.kind != ErrorKind::Conflict
        || (expected.status == RunStatus::Running
            && error.message != "workflow run transition lost status race")
    {
        return Err(error);
    }
    let Some(live) = port.load_run(expected.org_id, expected.id).await? else {
        return Err(error);
    };
    if live.id != expected.id
        || live.org_id != expected.org_id
        || live.definition_id != expected.definition_id
        || live.definition_version != expected.definition_version
        || live.object_type != expected.object_type
        || live.object_id != expected.object_id
        || live.status == RunStatus::Starting
        || (expected.status == RunStatus::Running && live.status == RunStatus::Running)
    {
        return Err(error);
    }
    Ok(live.status)
}
