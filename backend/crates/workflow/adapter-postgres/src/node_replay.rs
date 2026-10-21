//! Compare replay material in one snapshot; delivery and human decisions may advance.
use super::*;
use console_workflow_domain::NodeStatus;
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};

pub(super) fn transition_material(commit: &NodeStepCommit) -> Value {
    commit
        .run_transition
        .as_ref()
        .map(|t| {
            json!({
                "run": t.run_id, "from": t.from.as_db_str(), "to": t.to.as_db_str(),
                "output": t.output_payload, "error": t.error_payload,
            })
        })
        .unwrap_or(Value::Null)
}

pub(super) async fn verify(
    tx: &mut Transaction<'_, Postgres>,
    commit: &NodeStepCommit,
) -> Result<(), PgWorkflowRuntimeError> {
    let node = &commit.new_node;
    let row = sqlx::query(
        r#"SELECT n.id, n.run_id, n.node_key, n.node_type, n.attempt, n.input_payload,
                  n.status, n.output_payload, n.error_payload,
           (SELECT a.after_snap->'run_transition' FROM audit_events a
             WHERE a.org_id=n.org_id AND a.target_id=n.id::text
               AND a.action='workflow_node.commit' AND a.after_snap ? 'run_transition'
             ORDER BY a.occurred_at, a.id LIMIT 1) AS run_transition,
           COALESCE((SELECT jsonb_agg(jsonb_build_object(
               'channel', e.channel, 'destination', e.destination_ref,
               'key', e.idempotency_key, 'payload', e.payload)
               ORDER BY e.idempotency_key)
             FROM workflow_outbox_events e WHERE e.org_id=n.org_id AND e.node_run_id=n.id), '[]') AS emissions,
           COALESCE((SELECT jsonb_agg(jsonb_build_object(
               'run', t.run_id, 'key', t.waiting_key, 'title', t.title,
               'assignee', t.assignee_role_key, 'policy', t.required_policy,
               'form', t.form_payload, 'due', (extract(epoch FROM t.due_at)*1000000)::bigint))
             FROM workflow_waiting_tasks t WHERE t.org_id=n.org_id AND t.node_run_id=n.id), '[]') AS tasks,
           EXISTS (SELECT 1 FROM workflow_waiting_tasks t
             WHERE t.org_id=n.org_id AND t.node_run_id=n.id
               AND t.status IN ('APPROVED','REJECTED') AND n.status='SUCCEEDED'
               AND (n.output_payload=jsonb_build_object('decision', t.decision_payload->>'decision')
                 OR (t.status='APPROVED' AND t.waiting_key='finalize.author'
                   AND n.output_payload=jsonb_build_object('finalized', true,
                     'awaiting_receipt', t.decision_payload->'awaiting_receipt')))) AS completed
         FROM workflow_node_runs n WHERE n.idempotency_key=$1"#,
    )
    .bind(&node.idempotency_key)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| KernelError::conflict("workflow node replay was not found"))?;
    let persisted_id: Uuid = row.try_get("id")?;
    let incoming_prefix = format!("outbox:{}:{}:", node.run_id, node.id);
    let persisted_prefix = format!("outbox:{}:{persisted_id}:", node.run_id);
    let mut expected_emissions: Vec<_> = commit
        .emissions
        .iter()
        .map(|e| {
            // Runtime retries generate a new node UUID; only that identity changes.
            let key = e
                .idempotency_key
                .strip_prefix(&incoming_prefix)
                .map(|suffix| format!("{persisted_prefix}{suffix}"))
                .unwrap_or_else(|| e.idempotency_key.clone());
            json!({
                "channel": e.channel.as_db_str(), "destination": e.destination_ref,
                "key": key, "payload": e.payload,
            })
        })
        .collect();
    expected_emissions.sort_by(|a, b| a["key"].as_str().cmp(&b["key"].as_str()));
    let expected_tasks: Vec<_> = commit
        .waiting_task
        .iter()
        .map(|t| {
            json!({
                "run": t.run_id, "key": t.waiting_key, "title": t.title,
                "assignee": t.assignee_role_key, "policy": t.required_policy,
                "form": t.form_payload,
                "due": t.due_at.map(|at| (at.unix_timestamp_nanos()/1000) as i64),
            })
        })
        .collect();
    // A completed human task replaces the waiting node's empty output with its decision.
    let completed: bool = row.try_get("completed")?;
    let final_matches = row.try_get::<String, _>("status")? == commit.node_final_status.as_db_str()
        && row.try_get::<Option<Value>, _>("output_payload")? == commit.node_output;
    let completed_matches = completed
        && commit.node_final_status == NodeStatus::Waiting
        && commit.node_output.is_none()
        && commit.waiting_task.is_some();
    let same = row.try_get::<Uuid, _>("run_id")? == node.run_id
        && row.try_get::<String, _>("node_key")? == node.node_key
        && row.try_get::<String, _>("node_type")? == node.node_type
        && row.try_get::<i32, _>("attempt")? == node.attempt
        && row.try_get::<Value, _>("input_payload")? == node.input_payload
        && row.try_get::<Option<Value>, _>("error_payload")? == commit.node_error
        && row.try_get::<Value, _>("emissions")? == json!(expected_emissions)
        && row.try_get::<Value, _>("tasks")? == json!(expected_tasks)
        && row
            .try_get::<Option<Value>, _>("run_transition")?
            .unwrap_or(Value::Null)
            == transition_material(commit)
        && commit
            .emissions
            .iter()
            .all(|e| e.node_run_id == Some(node.id))
        && commit
            .waiting_task
            .iter()
            .all(|t| t.node_run_id == Some(node.id))
        && (final_matches || completed_matches);
    if !same {
        return Err(KernelError::conflict("workflow node replay material changed").into());
    }
    Ok(())
}
