use super::*;

// console-gate: state-changing-handler
pub(super) fn commit_node_step<'a>(
    store: &'a PgWorkflowRuntimeStore,
    org: OrgId,
    mut commit: NodeStepCommit,
) -> PortFuture<'a, ()> {
    Box::pin(async move {
        let node = &commit.new_node;
        if commit
            .emissions
            .iter()
            .any(|e| e.node_run_id != Some(node.id))
            || commit
                .waiting_task
                .iter()
                .any(|t| t.node_run_id != Some(node.id) || t.run_id != node.run_id)
            || commit
                .run_transition
                .iter()
                .any(|t| t.run_id != node.run_id)
        {
            return Err(KernelError::conflict(
                "workflow node commit references another node or run",
            ));
        }
        if let Some(transition) = &commit.run_transition {
            console_workflow_domain::validate_run_transition(transition.from, transition.to)?;
        }
        with_audits::<_, (), PgWorkflowRuntimeError>(&store.pool, org, move |tx| {
            Box::pin(async move {
                let new_node = &commit.new_node;
                let org_uuid = *org.as_uuid();

                let inserted = sqlx::query(
                    "INSERT INTO workflow_node_runs \
                             (id, org_id, run_id, node_key, node_type, status, attempt, \
                              idempotency_key, input_payload) \
                         VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7, $8) \
                         ON CONFLICT (org_id, idempotency_key) DO NOTHING",
                )
                .bind(new_node.id)
                .bind(org_uuid)
                .bind(new_node.run_id)
                .bind(&new_node.node_key)
                .bind(&new_node.node_type)
                .bind(new_node.attempt)
                .bind(&new_node.idempotency_key)
                .bind(&new_node.input_payload)
                .execute(tx.as_mut())
                .await
                .map_err(PgWorkflowRuntimeError::from)?;

                if inserted.rows_affected() == 0 {
                    super::node_replay::verify(tx, &commit).await?;
                    return Ok(((), Vec::new()));
                }

                let transition = super::node_replay::transition_material(&commit);
                for audit in &mut commit.audit_events {
                    if audit.action.as_str() == "workflow_node.commit"
                        && audit.target_id == new_node.id.to_string()
                    {
                        let after = audit.after.get_or_insert_with(|| serde_json::json!({}));
                        after["run_transition"] = transition.clone();
                    }
                }

                let NodeStepCommit {
                    new_node,
                    node_final_status,
                    node_output,
                    node_error,
                    emissions,
                    waiting_task,
                    run_transition,
                    audit_events,
                } = commit;
                // 2. Node PENDING -> RUNNING.
                sqlx::query(
                    "UPDATE workflow_node_runs \
                         SET status = 'RUNNING', started_at = now(), updated_at = now() \
                         WHERE id = $1 AND status = 'PENDING'",
                )
                .bind(new_node.id)
                .execute(tx.as_mut())
                .await
                .map_err(PgWorkflowRuntimeError::from)?;

                // A new node must own new emission keys; replays returned above.
                for emission in emissions {
                    let inserted = sqlx::query(
                        "INSERT INTO workflow_outbox_events \
                                 (org_id, run_id, node_run_id, channel, destination_ref, \
                                  idempotency_key, status, payload) \
                             VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7) \
                             ON CONFLICT (org_id, idempotency_key) DO NOTHING",
                    )
                    .bind(org_uuid)
                    .bind(new_node.run_id)
                    .bind(emission.node_run_id)
                    .bind(emission.channel.as_db_str())
                    .bind(emission.destination_ref)
                    .bind(emission.idempotency_key)
                    .bind(emission.payload)
                    .execute(tx.as_mut())
                    .await
                    .map_err(PgWorkflowRuntimeError::from)?;
                    if inserted.rows_affected() == 0 {
                        return Err(KernelError::conflict(
                            "workflow emission key belongs to another node",
                        )
                        .into());
                    }
                }

                // 4. Optional waiting task (run parks on it).
                if let Some(task) = waiting_task {
                    sqlx::query(
                        "INSERT INTO workflow_waiting_tasks \
                                 (org_id, run_id, node_run_id, waiting_key, title, status, \
                                  assignee_role_key, required_policy, form_payload, due_at) \
                             VALUES ($1, $2, $3, $4, $5, 'OPEN', $6, $7, $8, $9)",
                    )
                    .bind(org_uuid)
                    .bind(task.run_id)
                    .bind(task.node_run_id)
                    .bind(task.waiting_key)
                    .bind(task.title)
                    .bind(task.assignee_role_key)
                    .bind(task.required_policy)
                    .bind(task.form_payload)
                    .bind(task.due_at)
                    .execute(tx.as_mut())
                    .await
                    .map_err(PgWorkflowRuntimeError::from)?;
                }

                // 5. Node RUNNING -> final. Terminal statuses stamp finished_at.
                let node_sql = if node_final_status.sets_finished_at() {
                    "UPDATE workflow_node_runs \
                         SET status = $2, updated_at = now(), finished_at = now(), \
                             output_payload = $3, error_payload = $4 \
                         WHERE id = $1 AND status = 'RUNNING'"
                } else {
                    "UPDATE workflow_node_runs \
                         SET status = $2, updated_at = now(), \
                             output_payload = $3, error_payload = $4 \
                         WHERE id = $1 AND status = 'RUNNING'"
                };
                sqlx::query(node_sql)
                    .bind(new_node.id)
                    .bind(node_final_status.as_db_str())
                    .bind(node_output)
                    .bind(node_error)
                    .execute(tx.as_mut())
                    .await
                    .map_err(PgWorkflowRuntimeError::from)?;

                // 6. Optional run transition (e.g. RUNNING -> WAITING on a gate).
                if let Some(transition) = run_transition {
                    let result = sqlx::query(run_transition_sql(transition.to))
                        .bind(transition.run_id)
                        .bind(transition.to.as_db_str())
                        .bind(transition.from.as_db_str())
                        .bind(transition.output_payload)
                        .bind(transition.error_payload)
                        .execute(tx.as_mut())
                        .await
                        .map_err(PgWorkflowRuntimeError::from)?;
                    if result.rows_affected() != 1 {
                        return Err(KernelError::conflict(
                            "workflow run transition lost status race",
                        )
                        .into());
                    }
                }

                Ok(((), audit_events))
            })
        })
        .await
        .map_err(KernelError::from)
    })
}
