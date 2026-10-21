//! System-triggered run starts (BE-AUTO slice 1).
//!
//! One shared entry for every NON-human run producer — the domain-event
//! trigger-binding dispatcher and the cron schedule poller — so both start a
//! run exactly the way the REST `POST /api/v1/workflow-runs` path does
//! (`start_run` → synchronous [`drive_from`] until the first WAITING task or a
//! terminal node) without duplicating the walk. Pure over the domain port: no
//! sqlx here; callers resolve the published definition JSON themselves.
//!
//! ## Exactly-once
//! The caller supplies a DETERMINISTIC `idempotency_key` (e.g.
//! `trigger:{binding_id}:{object_id}` or `schedule:{schedule_id}:{fire_unix}`).
//! The run spine's `UNIQUE(org_id, idempotency_key)` turns a concurrent double
//! dispatch/poll into a Conflict; this module reloads the existing run and
//! either resumes an in-flight run or reports a benign already-handled skip.
//!
//! ## Authorization
//! A system start carries NO per-request principal: the authority is the
//! audited AUTHORING act (creating/enabling the binding or schedule required
//! the workflow-manage feature), matching how the m2 completion reconciler
//! re-drives with an empty guard set. Every write is still fully audited (actor
//! `None` ⇒ system) through the port's own `with_audit(s)` transactions.

use console_kernel_core::{ErrorKind, KernelError};
use console_workflow_domain::{RunRecord, RunStatus, RunTransition, WorkflowRuntimePort};
use serde_json::Value;

use crate::engine::{
    AuditContext, StartRunRequest, recover_started_status, run_audit_event, start_run_owned,
};
use crate::graph::{ExecGraph, drive_from};

/// How a system-triggered start landed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TriggeredStart {
    /// A fresh run was created and driven to its first WAITING task or a
    /// terminal node.
    Started {
        run_id: uuid::Uuid,
        run_status: RunStatus,
    },
    /// A run under the same deterministic idempotency key already exists — the
    /// event/fire was already handled (possibly by a concurrent dispatcher).
    AlreadyStarted,
}

#[derive(Debug, Clone)]
struct RequestedDefinition {
    id: uuid::Uuid,
    version: i32,
    object_type: Option<String>,
    object_id: Option<uuid::Uuid>,
}

/// Start a run for a trigger binding or schedule fire and drive it through its
/// `wf.exec.v1` node graph. Fails with a validation error when the definition
/// carries no executable node graph (e.g. the graph-less strangler completion
/// template, which is driven by its own hard-coded tail instead).
pub async fn start_bound_run<P: WorkflowRuntimePort + ?Sized>(
    port: &P,
    request: StartRunRequest,
    definition: &Value,
    audit: &AuditContext,
) -> Result<TriggeredStart, KernelError> {
    let graph = ExecGraph::parse(definition)?;
    let entry = graph.entry_node_key()?.to_owned();
    let org = request.org_id;
    let requested_definition = RequestedDefinition {
        id: request.definition_id,
        version: request.definition_version,
        object_type: request.object_type.clone(),
        object_id: request.object_id,
    };
    let idempotency_key = request.idempotency_key.clone();
    // The run context condition nodes evaluate against. A deterministic
    // re-dispatch/re-poll carries the same context, so a resumed run branches
    // identically.
    let context = request.context_payload.clone();

    match start_run_owned(port, request, audit).await {
        Ok(run_id) => {
            let outcome = drive_from(
                port,
                org,
                run_id,
                RunStatus::Running,
                &graph,
                &entry,
                Vec::new(),
                &context,
                audit,
            )
            .await;
            let run_status = match outcome {
                Ok(outcome) => outcome.run_status,
                Err(error) => {
                    recover_started_status(
                        port,
                        &RunRecord {
                            id: run_id,
                            org_id: org,
                            status: RunStatus::Running,
                            definition_id: requested_definition.id,
                            definition_version: requested_definition.version,
                            object_type: requested_definition.object_type,
                            object_id: requested_definition.object_id,
                        },
                        error,
                    )
                    .await?
                }
            };
            Ok(TriggeredStart::Started { run_id, run_status })
        }
        // UNIQUE(org_id, idempotency_key): this fire/event already has a run.
        // Inspect it instead of blindly skipping so a crash after INSERT but
        // before/within graph drive can be resumed.
        Err(failure) if !failure.inserted && failure.error.kind == ErrorKind::Conflict => {
            resume_conflicted_run(
                port,
                org,
                idempotency_key,
                requested_definition,
                &graph,
                &entry,
                &context,
                audit,
            )
            .await
        }
        Err(failure) => Err(failure.error),
    }
}

#[allow(clippy::too_many_arguments)]
async fn resume_conflicted_run<P: WorkflowRuntimePort + ?Sized>(
    port: &P,
    org: console_kernel_core::OrgId,
    idempotency_key: String,
    requested_definition: RequestedDefinition,
    graph: &ExecGraph,
    entry: &str,
    context: &Value,
    audit: &AuditContext,
) -> Result<TriggeredStart, KernelError> {
    let Some(existing) = port
        .load_run_by_idempotency_key(org, idempotency_key)
        .await?
    else {
        return Err(KernelError::conflict(
            "workflow run idempotency conflict but existing run was not found",
        ));
    };

    if existing.definition_id != requested_definition.id
        || existing.definition_version != requested_definition.version
        || existing.org_id != org
        || existing.object_type != requested_definition.object_type
        || existing.object_id != requested_definition.object_id
    {
        return Err(KernelError::conflict(
            "workflow run idempotency conflict belongs to a different definition version",
        ));
    }

    match existing.status {
        RunStatus::Starting => {
            let transition = RunTransition {
                run_id: existing.id,
                from: RunStatus::Starting,
                to: RunStatus::Running,
                output_payload: None,
                error_payload: None,
            };
            let transition_audit = run_audit_event(
                "workflow_run.transition",
                audit,
                existing.id,
                org,
                Some(serde_json::json!({ "status": RunStatus::Starting.as_db_str() })),
                Some(serde_json::json!({ "status": RunStatus::Running.as_db_str() })),
            )?;
            if let Err(err) = port.transition_run(org, transition, transition_audit).await {
                recover_started_status(port, &existing, err).await?;
                return Ok(TriggeredStart::AlreadyStarted);
            }
            let _ = drive_existing_running(port, org, existing.id, graph, entry, context, audit)
                .await?;
            Ok(TriggeredStart::AlreadyStarted)
        }
        RunStatus::Running => {
            let _ = drive_existing_running(port, org, existing.id, graph, entry, context, audit)
                .await?;
            Ok(TriggeredStart::AlreadyStarted)
        }
        RunStatus::Waiting => Ok(TriggeredStart::AlreadyStarted),
        RunStatus::Succeeded
        | RunStatus::Failed
        | RunStatus::Cancelled
        | RunStatus::DeadLettered => Ok(TriggeredStart::AlreadyStarted),
    }
}

#[allow(clippy::too_many_arguments)]
async fn drive_existing_running<P: WorkflowRuntimePort + ?Sized>(
    port: &P,
    org: console_kernel_core::OrgId,
    run_id: uuid::Uuid,
    graph: &ExecGraph,
    entry: &str,
    context: &Value,
    audit: &AuditContext,
) -> Result<TriggeredStart, KernelError> {
    let outcome = drive_from(
        port,
        org,
        run_id,
        RunStatus::Running,
        graph,
        entry,
        Vec::new(),
        context,
        audit,
    )
    .await?;
    Ok(TriggeredStart::Started {
        run_id,
        run_status: outcome.run_status,
    })
}

#[cfg(test)]
#[path = "trigger_tests.rs"]
mod tests;
