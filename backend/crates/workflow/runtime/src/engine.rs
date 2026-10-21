//! FSM-driven advance logic.
//!
//! Walks a run/node through the domain transition tables ([`validate_run_transition`],
//! [`validate_node_transition`]) and commits each step through the
//! [`WorkflowRuntimePort`]. Sync-in-request advance up to the first WAITING/terminal
//! node; the port arms `app.current_org` and writes audit rows in the same
//! transaction as each mutation.

use console_kernel_core::{
    AuditAction, AuditEvent, KernelError, OrgId, Timestamp, TraceContext, UserId,
};
use console_workflow_domain::{
    NewNodeRun, NodeStatus, NodeStepCommit, RunStatus, RunTransition, TriggerType,
    WorkflowRuntimePort, validate_node_transition, validate_run_transition,
};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::idempotency::node_attempt_key;
use crate::interpreter::{NodeOutcome, NodeSpec, interpret_node};

#[path = "audit_events.rs"]
mod audit_events;
pub(crate) use audit_events::run_audit_event;
use audit_events::{guardrail_audit_event, node_audit_event};

/// Per-request audit metadata threaded onto every emitted [`AuditEvent`].
#[derive(Debug, Clone)]
pub struct AuditContext {
    /// `None` for a system-initiated advance (background worker).
    pub actor: Option<UserId>,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

/// Inputs to start (and immediately activate) a new run. `run_id` is pre-generated
/// so the run/node/outbox idempotency keys can be derived before the row exists.
#[derive(Debug, Clone)]
pub struct StartRunRequest {
    pub run_id: Uuid,
    pub org_id: OrgId,
    pub definition_id: Uuid,
    pub definition_version: i32,
    pub trigger_type: TriggerType,
    pub object_type: Option<String>,
    pub object_id: Option<Uuid>,
    pub idempotency_key: String,
    pub correlation_id: String,
    pub trace_id: Option<String>,
    pub input_payload: Value,
    pub context_payload: Value,
    pub initiated_by: Option<UserId>,
    /// The `workflow_schedules` row that fired this run (schedule-poller starts
    /// only); `None` for manual/API/event-triggered runs.
    pub schedule_id: Option<Uuid>,
}

/// Inputs to process one node atomically.
#[derive(Debug, Clone)]
pub struct ProcessNodeRequest {
    pub org_id: OrgId,
    pub run_id: Uuid,
    /// Pre-generated node id so emission keys can reference it.
    pub node_run_id: Uuid,
    /// The run's current status, used to validate the run transition below.
    pub current_run_status: RunStatus,
    /// Where the run should sit after this node (RUNNING to keep advancing, WAITING
    /// to park, or a terminal status). Equal to `current_run_status` ⇒ no run
    /// transition is written.
    pub run_target: RunStatus,
    pub spec: NodeSpec,
    pub attempt: i32,
    pub input_payload: Value,
    /// Cedar/PBAC observe-and-record shadow audit rows produced by the caller's
    /// guard(s) for this transition (design §D). They are folded into the node
    /// step's own `with_audits` transaction so the shadow decision commits (or
    /// rolls back) atomically with the node it guards. Empty when the node is a
    /// worker-driven system node that is audited but not per-request Cedar-guarded.
    pub guard_audits: Vec<AuditEvent>,
}

/// The statuses the run/node landed after a processed node.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NodeStepOutcome {
    pub node_final_status: NodeStatus,
    pub run_status: RunStatus,
}

#[path = "start.rs"]
mod start;
pub use start::start_run;
pub(crate) use start::{recover_started_status, start_run_owned};

/// Process one node atomically: interpret it, validate the node walk
/// (PENDING→RUNNING→final) and the run transition against the FSM tables, then
/// commit the whole step (node + emissions + optional waiting task + optional run
/// transition + audit) in a single port transaction.
pub async fn process_node<P: WorkflowRuntimePort + ?Sized>(
    port: &P,
    request: ProcessNodeRequest,
    audit: &AuditContext,
) -> Result<NodeStepOutcome, KernelError> {
    let outcome = interpret_node(
        &request.spec,
        request.run_id,
        request.node_run_id,
        &request.input_payload,
    );
    let node_final_status = outcome.node_status();

    // Node walk: PENDING → RUNNING → final. Reject an illegal landing state.
    validate_node_transition(NodeStatus::Pending, NodeStatus::Running)?;
    validate_node_transition(NodeStatus::Running, node_final_status)?;

    // Run transition (skip when the run stays put).
    let run_transition = if request.run_target == request.current_run_status {
        None
    } else {
        validate_run_transition(request.current_run_status, request.run_target)?;
        Some(RunTransition {
            run_id: request.run_id,
            from: request.current_run_status,
            to: request.run_target,
            output_payload: None,
            error_payload: None,
        })
    };

    let (node_output, node_error, emissions, waiting_task, selected_port, guardrail_audit_actions) =
        match outcome {
            NodeOutcome::Succeeded {
                output,
                emissions,
                selected_port,
                audit_actions,
            } => (
                Some(with_selected_port(output, selected_port.as_deref())),
                None,
                emissions,
                None,
                selected_port,
                audit_actions,
            ),
            NodeOutcome::Waiting {
                task,
                selected_port,
                audit_actions,
            } => (
                None,
                None,
                Vec::new(),
                Some(task),
                selected_port,
                audit_actions,
            ),
            NodeOutcome::Failed {
                error,
                selected_port,
                audit_actions,
            } => (
                None,
                Some(with_selected_port(error, selected_port.as_deref())),
                Vec::new(),
                None,
                selected_port,
                audit_actions,
            ),
        };

    let new_node = NewNodeRun {
        id: request.node_run_id,
        run_id: request.run_id,
        node_key: request.spec.node_key.clone(),
        node_type: request.spec.node_type.clone(),
        attempt: request.attempt,
        idempotency_key: node_attempt_key(request.run_id, &request.spec.node_key, request.attempt),
        input_payload: request.input_payload,
    };

    let node_audit = node_audit_event(
        "workflow_node.commit",
        audit,
        request.node_run_id,
        request.org_id,
        node_final_status,
    )?;

    // The node's own audit row plus guardrail-specific audit rows and any
    // Cedar/PBAC shadow audit rows the caller's guard produced for this transition
    // (design §D) — one atomic `with_audits` txn.
    let mut audit_events =
        Vec::with_capacity(1 + guardrail_audit_actions.len() + request.guard_audits.len());
    audit_events.push(node_audit);
    for action in guardrail_audit_actions {
        audit_events.push(guardrail_audit_event(
            &action,
            audit,
            request.node_run_id,
            request.org_id,
            node_final_status,
            selected_port.as_deref(),
        )?);
    }
    audit_events.extend(request.guard_audits);

    let commit = NodeStepCommit {
        new_node,
        node_final_status,
        node_output,
        node_error,
        emissions,
        waiting_task,
        run_transition,
        audit_events,
    };
    port.commit_node_step(request.org_id, commit).await?;

    Ok(NodeStepOutcome {
        node_final_status,
        run_status: request.run_target,
    })
}

fn with_selected_port(payload: Value, selected_port: Option<&str>) -> Value {
    let Some(selected_port) = selected_port else {
        return payload;
    };
    match payload {
        Value::Object(mut map) => {
            map.entry("selected_port".to_owned())
                .or_insert_with(|| json!(selected_port));
            Value::Object(map)
        }
        other => json!({
            "selected_port": selected_port,
            "payload": other,
        }),
    }
}

#[cfg(test)]
#[path = "engine_tests.rs"]
mod tests;
