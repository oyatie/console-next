use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;
use std::task::{Context, Poll, Waker};

use console_kernel_core::{ErrorKind, OrgId, TraceContext, UserId};
use console_workflow_domain::{
    FinalizeWaitingTaskCommand, FinalizeWaitingTaskContext, FinalizedWaitingTask, NewRun,
    NodeStepCommit, PortFuture, PostFinalizationRejection, PostFinalizationRejectionCommand,
    RunRecord, TriggerType,
};
use serde_json::json;
use time::OffsetDateTime;
use uuid::Uuid;

use super::*;

struct ConflictPort {
    org: OrgId,
    idempotency_key: String,
    existing: RunRecord,
    transitions: Mutex<Vec<RunTransition>>,
    commits: Mutex<Vec<NodeStepCommit>>,
    insert_ok: bool,
    transition_conflict: bool,
    drive_conflict: bool,
    drive_material_conflict: bool,
    missing: bool,
}

impl WorkflowRuntimePort for ConflictPort {
    fn insert_run<'a>(
        &'a self,
        _run: NewRun,
        _audit: console_kernel_core::AuditEvent,
    ) -> PortFuture<'a, ()> {
        Box::pin(async {
            if self.insert_ok {
                Ok(())
            } else {
                Err(KernelError::conflict("duplicate idempotency key"))
            }
        })
    }

    fn load_run<'a>(&'a self, _org: OrgId, run_id: Uuid) -> PortFuture<'a, Option<RunRecord>> {
        Box::pin(async move {
            Ok((!self.missing && run_id == self.existing.id).then(|| self.existing.clone()))
        })
    }

    fn load_run_by_idempotency_key<'a>(
        &'a self,
        org: OrgId,
        idempotency_key: String,
    ) -> PortFuture<'a, Option<RunRecord>> {
        Box::pin(async move {
            Ok((org == self.org && idempotency_key == self.idempotency_key)
                .then(|| self.existing.clone()))
        })
    }

    fn transition_run<'a>(
        &'a self,
        _org: OrgId,
        transition: RunTransition,
        _audit: console_kernel_core::AuditEvent,
    ) -> PortFuture<'a, ()> {
        Box::pin(async move {
            self.transitions.lock().unwrap().push(transition);
            if self.transition_conflict {
                Err(KernelError::conflict("activation race"))
            } else {
                Ok(())
            }
        })
    }

    fn commit_node_step<'a>(&'a self, _org: OrgId, commit: NodeStepCommit) -> PortFuture<'a, ()> {
        Box::pin(async move {
            self.commits.lock().unwrap().push(commit);
            if self.drive_conflict {
                Err(KernelError::conflict(if self.drive_material_conflict {
                    "workflow node replay material changed"
                } else {
                    "workflow run transition lost status race"
                }))
            } else {
                Ok(())
            }
        })
    }

    fn load_finalize_waiting_task<'a>(
        &'a self,
        _org: OrgId,
        _task_id: Uuid,
    ) -> PortFuture<'a, Option<FinalizeWaitingTaskContext>> {
        Box::pin(async { Ok(None) })
    }

    fn finalize_waiting_task<'a>(
        &'a self,
        _org: OrgId,
        _command: FinalizeWaitingTaskCommand,
    ) -> PortFuture<'a, FinalizedWaitingTask> {
        Box::pin(async { Err(KernelError::internal("not implemented in test port")) })
    }

    fn create_post_finalization_rejection<'a>(
        &'a self,
        _org: OrgId,
        _command: PostFinalizationRejectionCommand,
    ) -> PortFuture<'a, PostFinalizationRejection> {
        Box::pin(async { Err(KernelError::internal("not implemented in test port")) })
    }
}

fn conflict_port(status: RunStatus) -> ConflictPort {
    let org = OrgId::one();
    let run_id = Uuid::new_v4();
    ConflictPort {
        org,
        idempotency_key: "trigger:test-binding:test-object".to_owned(),
        existing: RunRecord {
            id: run_id,
            org_id: org,
            status,
            definition_id: Uuid::new_v4(),
            definition_version: 1,
            object_type: Some("work_order".to_owned()),
            object_id: Some(Uuid::new_v4()),
        },
        transitions: Mutex::new(Vec::new()),
        commits: Mutex::new(Vec::new()),
        insert_ok: false,
        transition_conflict: false,
        drive_conflict: false,
        drive_material_conflict: false,
        missing: false,
    }
}

fn request(port: &ConflictPort) -> StartRunRequest {
    StartRunRequest {
        run_id: Uuid::new_v4(),
        org_id: port.org,
        definition_id: port.existing.definition_id,
        definition_version: port.existing.definition_version,
        trigger_type: TriggerType::ObjectEvent,
        object_type: port.existing.object_type.clone(),
        object_id: port.existing.object_id,
        idempotency_key: port.idempotency_key.clone(),
        correlation_id: "trigger:test-object".to_owned(),
        trace_id: None,
        input_payload: json!({}),
        context_payload: json!({}),
        initiated_by: None,
        schedule_id: None,
    }
}

fn definition() -> serde_json::Value {
    json!({
        "nodes": [
            { "node_key": "gate", "node_type": "object_gate" }
        ],
        "edges": []
    })
}

fn audit_context() -> AuditContext {
    AuditContext {
        actor: Some(UserId::new()),
        trace: TraceContext::generate(),
        occurred_at: OffsetDateTime::now_utc(),
    }
}

fn block_on_ready<T>(future: impl Future<Output = T>) -> T {
    let mut context = Context::from_waker(Waker::noop());
    let mut future = Box::pin(future);
    match Pin::new(&mut future).poll(&mut context) {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("test future unexpectedly pending"),
    }
}

#[test]
fn conflicted_waiting_run_is_already_started_without_redrive() {
    let port = conflict_port(RunStatus::Waiting);

    let result = block_on_ready(start_bound_run(
        &port,
        request(&port),
        &definition(),
        &audit_context(),
    ))
    .unwrap();

    assert_eq!(result, TriggeredStart::AlreadyStarted);
    assert!(port.transitions.lock().unwrap().is_empty());
    assert!(port.commits.lock().unwrap().is_empty());
}

#[test]
fn conflicted_starting_run_transitions_and_resumes_drive() {
    let port = conflict_port(RunStatus::Starting);

    let result = block_on_ready(start_bound_run(
        &port,
        request(&port),
        &definition(),
        &audit_context(),
    ))
    .unwrap();

    assert_eq!(result, TriggeredStart::AlreadyStarted);
    let transitions = port.transitions.lock().unwrap();
    assert_eq!(transitions.len(), 1);
    assert_eq!(transitions[0].from, RunStatus::Starting);
    assert_eq!(transitions[0].to, RunStatus::Running);
    let commits = port.commits.lock().unwrap();
    let run_transition = commits[0]
        .run_transition
        .as_ref()
        .expect("resumed drive closes the one-node graph");
    assert_eq!(run_transition.from, RunStatus::Running);
    assert_eq!(run_transition.to, RunStatus::Succeeded);
}

#[test]
fn conflicted_run_rejects_definition_drift() {
    let port = conflict_port(RunStatus::Running);
    let mut request = request(&port);
    request.definition_version += 1;

    let err = block_on_ready(start_bound_run(
        &port,
        request,
        &definition(),
        &audit_context(),
    ))
    .expect_err("existing run must not be resumed with a different definition version");

    assert_eq!(err.kind, ErrorKind::Conflict);
    assert!(port.transitions.lock().unwrap().is_empty());
    assert!(port.commits.lock().unwrap().is_empty());
}

#[path = "trigger_race_tests.rs"]
mod race_tests;
