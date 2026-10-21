use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;
use std::task::{Context, Poll, Waker};

use console_kernel_core::ErrorKind;
use console_workflow_domain::{
    FinalizeWaitingTaskCommand, FinalizeWaitingTaskContext, FinalizedWaitingTask, NewRun,
    NodeStepCommit, PortFuture, PostFinalizationRejection, PostFinalizationRejectionCommand,
    RunRecord,
};

use super::*;
use crate::interpreter::NodeKind;

#[derive(Default)]
struct RecordingPort {
    commits: Mutex<Vec<NodeStepCommit>>,
}

impl WorkflowRuntimePort for RecordingPort {
    fn insert_run<'a>(&'a self, _run: NewRun, _audit: AuditEvent) -> PortFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    fn load_run<'a>(&'a self, _org: OrgId, _run_id: Uuid) -> PortFuture<'a, Option<RunRecord>> {
        Box::pin(async { Ok(None) })
    }

    fn load_run_by_idempotency_key<'a>(
        &'a self,
        _org: OrgId,
        _idempotency_key: String,
    ) -> PortFuture<'a, Option<RunRecord>> {
        Box::pin(async { Ok(None) })
    }

    fn transition_run<'a>(
        &'a self,
        _org: OrgId,
        _transition: RunTransition,
        _audit: AuditEvent,
    ) -> PortFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    fn commit_node_step<'a>(&'a self, _org: OrgId, commit: NodeStepCommit) -> PortFuture<'a, ()> {
        Box::pin(async move {
            self.commits.lock().unwrap().push(commit);
            Ok(())
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

fn audit_context() -> AuditContext {
    AuditContext {
        actor: Some(UserId::new()),
        trace: TraceContext::generate(),
        occurred_at: time::OffsetDateTime::now_utc(),
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
fn author_finalize_node_parks_run_waiting_before_terminal_success() {
    let port = RecordingPort::default();
    let org = OrgId::one();
    let run_id = Uuid::new_v4();
    let node_run_id = Uuid::new_v4();

    let outcome = block_on_ready(process_node(
        &port,
        ProcessNodeRequest {
            org_id: org,
            run_id,
            node_run_id,
            current_run_status: RunStatus::Running,
            run_target: RunStatus::Waiting,
            spec: NodeSpec {
                node_key: "finalize.author".to_owned(),
                node_type: "human_task".to_owned(),
                kind: NodeKind::HumanTask {
                    title: "Author finalize".to_owned(),
                    required_policy: Some("approval_finalize".to_owned()),
                    assignee_role_key: Some("initiator".to_owned()),
                },
            },
            attempt: 1,
            input_payload: json!({}),
            guard_audits: Vec::new(),
        },
        &audit_context(),
    ))
    .unwrap();

    assert_eq!(outcome.node_final_status, NodeStatus::Waiting);
    assert_eq!(outcome.run_status, RunStatus::Waiting);
    let commits = port.commits.lock().unwrap();
    let commit = commits.first().expect("node commit recorded");
    let transition = commit
        .run_transition
        .as_ref()
        .expect("finalize parks the run");
    assert_eq!(transition.from, RunStatus::Running);
    assert_eq!(transition.to, RunStatus::Waiting);
    let task = commit.waiting_task.as_ref().expect("waiting task recorded");
    assert_eq!(task.waiting_key, "finalize.author");
    assert_eq!(task.required_policy.as_deref(), Some("approval_finalize"));
}

#[test]
fn terminal_run_cannot_be_reopened_for_late_finalization() {
    let port = RecordingPort::default();
    let err = block_on_ready(process_node(
        &port,
        ProcessNodeRequest {
            org_id: OrgId::one(),
            run_id: Uuid::new_v4(),
            node_run_id: Uuid::new_v4(),
            current_run_status: RunStatus::Succeeded,
            run_target: RunStatus::Waiting,
            spec: NodeSpec {
                node_key: "finalize.author".to_owned(),
                node_type: "human_task".to_owned(),
                kind: NodeKind::HumanTask {
                    title: "Author finalize".to_owned(),
                    required_policy: Some("approval_finalize".to_owned()),
                    assignee_role_key: Some("initiator".to_owned()),
                },
            },
            attempt: 1,
            input_payload: json!({}),
            guard_audits: Vec::new(),
        },
        &audit_context(),
    ))
    .expect_err("terminal run must not reopen for late finalization");

    assert_eq!(err.kind, ErrorKind::InvalidTransition);
    assert!(port.commits.lock().unwrap().is_empty());
}
