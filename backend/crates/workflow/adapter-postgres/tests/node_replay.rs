#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_kernel_core::ErrorKind;
use console_platform_request_context::scope_org;
use console_workflow_domain::{
    NodeStatus, OutboxChannel, RunStatus, RunTransition, WorkflowRuntimePort,
};
use serde_json::json;
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

#[path = "fixtures/node_material.rs"]
mod fixture;
use fixture::{counts, fixture, regenerate_ids};

#[path = "fixtures/node_refusals.rs"]
mod refusals;

async fn unchanged(pool: PgPool, waiting: bool) {
    let (store, org, mut commit) = fixture(&pool, waiting).await;
    scope_org(org, store.commit_node_step(org, commit.clone()))
        .await
        .unwrap();
    let before = counts(&pool).await;
    regenerate_ids(&mut commit);
    scope_org(org, store.commit_node_step(org, commit))
        .await
        .expect("unchanged node is a no-op");
    assert_eq!(
        counts(&pool).await,
        before,
        "replay must neither enqueue nor append audit"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unchanged_job_replay_preserves_effects_and_audits(pool: PgPool) {
    unchanged(pool, false).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unchanged_waiting_replay_preserves_effects_and_audits(pool: PgPool) {
    unchanged(pool, true).await;
}

async fn changed(pool: PgPool, shapes: &[&str], waiting: bool) {
    let (store, org, original) = fixture(&pool, waiting).await;
    scope_org(org, store.commit_node_step(org, original.clone()))
        .await
        .unwrap();
    let before = counts(&pool).await;
    for shape in shapes {
        let mut commit = original.clone();
        match *shape {
            "output" => commit.node_output = Some(json!({"output":2})),
            "status" => commit.node_final_status = NodeStatus::Failed,
            "key" => commit.new_node.node_key = "different".into(),
            "attempt" => commit.new_node.attempt += 1,
            "destination" => commit.emissions[0].destination_ref = Some("other".into()),
            "channel" => commit.emissions[0].channel = OutboxChannel::Notification,
            "title" => commit.waiting_task.as_mut().unwrap().title = "Other".into(),
            "due" => commit.waiting_task.as_mut().unwrap().due_at = Some(OffsetDateTime::now_utc()),
            "input" => commit.new_node.input_payload = json!({"input":2}),
            "payload" => commit.emissions[0].payload = json!({"job":"payroll_draft","amount":2}),
            "policy" => {
                commit.waiting_task.as_mut().unwrap().required_policy = Some("admin".into())
            }
            "assignee" => {
                commit.waiting_task.as_mut().unwrap().assignee_role_key = Some("admin".into())
            }
            "form" => commit.waiting_task.as_mut().unwrap().form_payload = json!({"amount":2}),
            _ => panic!("unknown test shape"),
        }
        let err = scope_org(org, store.commit_node_step(org, commit))
            .await
            .expect_err("changed material must conflict");
        assert_eq!(err.kind, ErrorKind::Conflict, "{shape}");
        assert_eq!(
            counts(&pool).await,
            before,
            "{shape} changed durable effects"
        );
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn changed_node_input_conflicts_without_writes(pool: PgPool) {
    changed(
        pool,
        &["input", "output", "status", "key", "attempt"],
        false,
    )
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn changed_job_payload_conflicts_without_writes(pool: PgPool) {
    changed(pool, &["payload", "destination", "channel"], false).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn changed_approval_settings_conflict_without_writes(pool: PgPool) {
    changed(pool, &["policy", "assignee", "form", "title", "due"], true).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn waiting_replay_does_not_reopen_a_completed_human_task(pool: PgPool) {
    let (store, org, mut commit) = fixture(&pool, true).await;
    scope_org(org, store.commit_node_step(org, commit.clone()))
        .await
        .unwrap();
    sqlx::query("UPDATE workflow_waiting_tasks SET status='APPROVED', decision_payload='{\"decision\":\"approve\"}' WHERE node_run_id=$1")
        .bind(commit.new_node.id).execute(&pool).await.unwrap();
    sqlx::query("UPDATE workflow_node_runs SET status='SUCCEEDED', output_payload='{\"decision\":\"approve\"}' WHERE id=$1")
        .bind(commit.new_node.id).execute(&pool).await.unwrap();
    let before = counts(&pool).await;
    regenerate_ids(&mut commit);
    scope_org(org, store.commit_node_step(org, commit))
        .await
        .unwrap();
    assert_eq!(counts(&pool).await, before);
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT status FROM workflow_waiting_tasks")
            .fetch_one(&pool)
            .await
            .unwrap(),
        "APPROVED"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn transition_replay_is_exact_even_after_run_progress(pool: PgPool) {
    let (store, org, mut commit) = fixture(&pool, true).await;
    commit.run_transition = Some(RunTransition {
        run_id: commit.new_node.run_id,
        from: RunStatus::Running,
        to: RunStatus::Waiting,
        output_payload: None,
        error_payload: None,
    });
    scope_org(org, store.commit_node_step(org, commit.clone()))
        .await
        .unwrap();
    sqlx::query("UPDATE workflow_runs SET status='SUCCEEDED' WHERE id=$1")
        .bind(commit.new_node.run_id)
        .execute(&pool)
        .await
        .unwrap();
    let before = counts(&pool).await;
    let mut replay = commit.clone();
    regenerate_ids(&mut replay);
    scope_org(org, store.commit_node_step(org, replay))
        .await
        .unwrap();
    for shape in ["missing", "target", "output", "error"] {
        let mut changed = commit.clone();
        match shape {
            "missing" => changed.run_transition = None,
            "target" => changed.run_transition.as_mut().unwrap().to = RunStatus::Failed,
            "output" => {
                changed.run_transition.as_mut().unwrap().output_payload = Some(json!({"x":1}))
            }
            _ => changed.run_transition.as_mut().unwrap().error_payload = Some(json!({"x":1})),
        }
        let error = scope_org(org, store.commit_node_step(org, changed))
            .await
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::Conflict, "{shape}");
        assert_eq!(counts(&pool).await, before);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn finalized_author_task_replay_preserves_completion(pool: PgPool) {
    let (store, org, mut commit) = fixture(&pool, true).await;
    commit.waiting_task.as_mut().unwrap().waiting_key = "finalize.author".into();
    scope_org(org, store.commit_node_step(org, commit.clone()))
        .await
        .unwrap();
    sqlx::query("UPDATE workflow_waiting_tasks SET status='APPROVED', decision_payload='{\"mode\":\"AUTHOR\",\"awaiting_receipt\":true}' WHERE node_run_id=$1")
        .bind(commit.new_node.id).execute(&pool).await.unwrap();
    sqlx::query("UPDATE workflow_node_runs SET status='SUCCEEDED',output_payload='{\"finalized\":true,\"awaiting_receipt\":true}' WHERE id=$1")
        .bind(commit.new_node.id).execute(&pool).await.unwrap();
    let before = counts(&pool).await;
    regenerate_ids(&mut commit);
    scope_org(org, store.commit_node_step(org, commit))
        .await
        .unwrap();
    assert_eq!(counts(&pool).await, before);
}
