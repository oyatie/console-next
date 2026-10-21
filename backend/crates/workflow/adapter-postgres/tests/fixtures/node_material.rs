#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext};
use console_platform_test_support::runtime_role_pool;
use console_workflow_domain::{
    NewNodeRun, NewWaitingTask, NodeStatus, NodeStepCommit, OutboxChannel, OutboxEmission,
};
use console_workflow_runtime_adapter_postgres::PgWorkflowRuntimeStore;
use serde_json::json;
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

pub(super) async fn fixture(
    pool: &PgPool,
    waiting: bool,
) -> (PgWorkflowRuntimeStore, OrgId, NodeStepCommit) {
    let org = OrgId::one();
    sqlx::query("INSERT INTO organizations (id,slug,name) VALUES ($1,'replay','Replay') ON CONFLICT (id) DO NOTHING")
        .bind(org.as_uuid()).execute(pool).await.unwrap();
    let def: Uuid = sqlx::query_scalar("INSERT INTO workflow_definitions (org_id,workflow_key,display_name,object_type,status,latest_version,active_version) VALUES ($1,'replay.test','Replay','work_order','ACTIVE',1,1) RETURNING id")
        .bind(org.as_uuid()).fetch_one(pool).await.unwrap();
    sqlx::query("INSERT INTO workflow_definition_versions (org_id,definition_id,version,status,definition,required_approval_line,required_payment_line) VALUES ($1,$2,1,'PUBLISHED','{}',true,true)")
        .bind(org.as_uuid()).bind(def).execute(pool).await.unwrap();
    let run: Uuid = sqlx::query_scalar("INSERT INTO workflow_runs (org_id,definition_id,definition_version,status,trigger_type,idempotency_key,correlation_id,input_payload) VALUES ($1,$2,1,'RUNNING','OBJECT_EVENT',$3,$3,'{}') RETURNING id")
        .bind(org.as_uuid()).bind(def).bind(Uuid::new_v4().to_string()).fetch_one(pool).await.unwrap();
    let node = Uuid::new_v4();
    let commit = NodeStepCommit {
        new_node: NewNodeRun {
            id: node,
            run_id: run,
            node_key: "replay.node".into(),
            node_type: if waiting { "human_task" } else { "job" }.into(),
            attempt: 1,
            idempotency_key: format!("node:{run}:replay.node:1"),
            input_payload: json!({"input":1}),
        },
        node_final_status: if waiting {
            NodeStatus::Waiting
        } else {
            NodeStatus::Succeeded
        },
        node_output: (!waiting).then(|| json!({"output":1})),
        node_error: None,
        emissions: if waiting {
            vec![]
        } else {
            vec![OutboxEmission {
                node_run_id: Some(node),
                channel: OutboxChannel::Job,
                destination_ref: Some("payroll".into()),
                idempotency_key: format!("outbox:{run}:{node}:job:payroll_draft"),
                payload: json!({"job":"payroll_draft","amount":1}),
            }]
        },
        waiting_task: waiting.then(|| NewWaitingTask {
            run_id: run,
            node_run_id: Some(node),
            waiting_key: "replay.node".into(),
            title: "Review".into(),
            assignee_role_key: Some("hr".into()),
            required_policy: Some("review".into()),
            form_payload: json!({"amount":1}),
            due_at: None,
        }),
        run_transition: None,
        audit_events: vec![
            AuditEvent::new(
                None,
                AuditAction::new("workflow_node.commit").unwrap(),
                "workflow_node_run",
                node.to_string(),
                TraceContext::generate(),
                OffsetDateTime::now_utc(),
            )
            .with_org(org),
        ],
    };
    (
        PgWorkflowRuntimeStore::new(runtime_role_pool(pool).await),
        org,
        commit,
    )
}

pub(super) fn regenerate_ids(commit: &mut NodeStepCommit) {
    let node = Uuid::new_v4();
    let prefix = format!("outbox:{}:{}:", commit.new_node.run_id, commit.new_node.id);
    commit.new_node.id = node;
    for emission in &mut commit.emissions {
        if let Some(suffix) = emission.idempotency_key.strip_prefix(&prefix) {
            emission.idempotency_key = format!("outbox:{}:{node}:{suffix}", commit.new_node.run_id);
        }
        emission.node_run_id = Some(node);
    }
    if let Some(task) = &mut commit.waiting_task {
        task.node_run_id = Some(node);
    }
}

pub(super) async fn counts(pool: &PgPool) -> (i64, i64, i64, i64) {
    sqlx::query_as("SELECT (SELECT count(*) FROM workflow_node_runs), (SELECT count(*) FROM workflow_outbox_events), (SELECT count(*) FROM workflow_waiting_tasks), (SELECT count(*) FROM audit_events WHERE action='workflow_node.commit')")
        .fetch_one(pool).await.unwrap()
}
