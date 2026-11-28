// SPDX-License-Identifier: LicenseRef-Proprietary
use super::WorkflowStudioError;
use console_kernel_core::KernelError;
use console_platform_db::{DbError, with_org_conn};
use console_workflow_runtime::{ExecGraph, HumanTaskSemantic};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use std::collections::HashSet;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct ApprovalLineOverrideStep {
    #[serde(default)]
    pub(super) node_key: Option<String>,
    pub(super) assignee_role_key: String,
    #[serde(default)]
    pub(super) title: Option<String>,
}

pub(super) async fn resolve_start_definition(
    pool: &PgPool,
    org: console_kernel_core::OrgId,
    definition_id: Uuid,
    requested_version: Option<i32>,
) -> Result<(i32, Value, bool, bool), WorkflowStudioError> {
    let row = with_org_conn::<
        _,
        Option<(
            String,
            Option<Value>,
            Option<i32>,
            Option<String>,
            Option<i32>,
            bool,
            bool,
        )>,
        DbError,
    >(pool, org, move |tx| {
        Box::pin(async move {
            let row = sqlx::query(
                "SELECT d.status, v.definition, v.version, v.status AS version_status, \
                        d.active_version, COALESCE(v.allow_approval_line_override, true) AS allow_override, COALESCE(v.required_approval_line, false) AS required_line \
                     FROM workflow_definitions d \
                     LEFT JOIN workflow_definition_versions v \
                       ON v.definition_id = d.id AND v.org_id = d.org_id \
                      AND v.version = COALESCE($2, d.active_version) \
                     WHERE d.id = $1",
            )
            .bind(definition_id)
            .bind(requested_version)
            .fetch_optional(tx.as_mut())
            .await?;
            let Some(row) = row else {
                return Ok(None);
            };
            Ok(Some((
                row.try_get("status")?,
                row.try_get("definition")?,
                row.try_get("version")?,
                row.try_get("version_status")?,
                row.try_get("active_version")?,
                row.try_get("allow_override")?,
                row.try_get("required_line")?,
            )))
        })
    })
    .await
    .map_err(WorkflowStudioError::from)?;

    let Some((
        status,
        definition,
        version,
        version_status,
        active_version,
        allow_override,
        required_line,
    )) = row
    else {
        return Err(WorkflowStudioError::from(KernelError::not_found(
            "workflow definition not found",
        )));
    };
    if status != "ACTIVE" {
        return Err(WorkflowStudioError::from(KernelError::conflict(
            "workflow definition is not active",
        )));
    }
    let (Some(definition), Some(version), Some(version_status)) =
        (definition, version, version_status)
    else {
        return Err(WorkflowStudioError::from(KernelError::conflict(
            "workflow definition has no published version to start",
        )));
    };
    if Some(version) != active_version && version_status != "PUBLISHED" {
        return Err(WorkflowStudioError::validation(
            "workflow definition version is not an approved (published) version",
        ));
    }
    Ok((version, definition, allow_override, required_line))
}

pub(super) fn apply_approval_line_overrides(
    definition: &mut Value,
    context_payload: &mut Value,
    allow_override: bool,
    required_approval_line: bool,
    overrides: &[ApprovalLineOverrideStep],
) -> Result<(), WorkflowStudioError> {
    if overrides.is_empty() {
        return Ok(());
    }
    if !allow_override {
        return Err(WorkflowStudioError::validation(
            "approval_line_override_forbidden: this workflow definition does not allow approval line overrides",
        ));
    }
    let graph = ExecGraph::parse(definition)?;
    let mut replaced = HashSet::new();
    for step in overrides {
        let role = step.assignee_role_key.trim();
        if !super::WORKFLOW_AUTHORITY_ROLE_KEYS.contains(&role) {
            return Err(WorkflowStudioError::validation(
                "approval line assignee must be a recognized reviewer role",
            ));
        }
        if step
            .title
            .as_ref()
            .is_some_and(|s| s.trim().chars().count() > 160)
        {
            return Err(WorkflowStudioError::validation(
                "approval step title exceeds 160 characters",
            ));
        }
        if let Some(raw_key) = &step.node_key {
            let key = raw_key.trim();
            if !replaced.insert(key) {
                return Err(WorkflowStudioError::validation(
                    "duplicate approval-line replacement",
                ));
            }
            let existing = graph
                .node_spec(key)
                .filter(|spec| spec.human_task_semantic() == Some(HumanTaskSemantic::Decision))
                .ok_or_else(|| {
                    WorkflowStudioError::validation(
                        "replacement must name an existing approval decision",
                    )
                })?;
            let node = definition["nodes"]
                .as_array_mut()
                .and_then(|nodes| {
                    nodes
                        .iter_mut()
                        .find(|node| node["node_key"] == existing.node_key)
                })
                .ok_or_else(|| WorkflowStudioError::validation("approval decision not found"))?;
            if node["required"].as_bool().unwrap_or(required_approval_line) {
                return Err(WorkflowStudioError::validation(
                    "required_approval_step_removed: required approval steps cannot be replaced",
                ));
            }
            node["assignee_role_key"] = json!(role);
            if let Some(title) = step
                .title
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                node["title"] = json!(title);
            }
        }
    }
    let additions: Vec<_> = overrides
        .iter()
        .filter(|step| step.node_key.is_none())
        .collect();
    if !additions.is_empty() {
        append_optional_steps(definition, &graph, &additions)?;
    }

    if !context_payload.is_object() {
        *context_payload = json!({});
    }
    if let Some(ctx) = context_payload.as_object_mut() {
        ctx.insert("approval_line_overrides".to_owned(), json!(overrides));
    }
    Ok(())
}

/// Insert after the last approval decision, ahead of author finalization and receipt. A graph
/// with multiple possible endings has no unambiguous place to append an optional reviewer.
fn append_optional_steps(
    definition: &mut Value,
    graph: &ExecGraph,
    steps: &[&ApprovalLineOverrideStep],
) -> Result<(), WorkflowStudioError> {
    let mut key = graph.entry_node_key()?;
    let mut visited = HashSet::new();
    let mut anchor = None;
    let edges = definition["edges"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    loop {
        if !visited.insert(key) {
            return Err(WorkflowStudioError::validation(
                "additional reviewers require a linear approval line",
            ));
        }
        let spec = graph
            .node_spec(key)
            .ok_or_else(|| WorkflowStudioError::validation("invalid approval graph edge"))?;
        if spec.human_task_semantic() == Some(HumanTaskSemantic::Decision) {
            anchor = Some(key);
        }
        let mut targets = edges.iter().filter(|edge| edge["from"] == key);
        let next = targets.next();
        if targets.next().is_some() {
            return Err(WorkflowStudioError::validation(
                "additional reviewers require a linear approval line",
            ));
        }
        let Some(to) = next.and_then(|edge| edge["to"].as_str()) else {
            break;
        };
        key = to;
    }
    let anchor = anchor.ok_or_else(|| {
        WorkflowStudioError::validation("additional reviewers require an approval decision")
    })?;
    let successor = graph.next_node_key(anchor).map(str::to_owned);
    let mut previous = anchor.to_owned();
    // An added review uses the existing approval-decision policy and cannot assume finalization duties.
    for (i, step) in steps.iter().enumerate() {
        let key = format!("optional.approval.step_{}", i + 1);
        if graph.node_spec(&key).is_some() {
            return Err(WorkflowStudioError::validation(
                "optional approval key already exists",
            ));
        }
        definition["nodes"].as_array_mut().ok_or_else(|| WorkflowStudioError::validation("approval graph has no nodes"))?.push(json!({
            "node_key":key, "node_type":"human_task", "required":false,
            "assignee_role_key":step.assignee_role_key.trim(),
            "title":step.title.as_deref().map(str::trim).filter(|s|!s.is_empty()).unwrap_or(step.assignee_role_key.trim()),
            "required_policy":"approval_decide"
        }));
        if definition["edges"].is_null() {
            definition["edges"] = json!([]);
        }
        let edges = definition["edges"]
            .as_array_mut()
            .ok_or_else(|| WorkflowStudioError::validation("invalid approval graph edges"))?;
        if let Some(edge) = edges.iter_mut().find(|edge| edge["from"] == previous) {
            edge["to"] = json!(key);
        } else {
            edges.push(json!({"from":previous,"to":key}));
        }
        previous = key;
    }
    if let Some(successor) = successor {
        definition["edges"]
            .as_array_mut()
            .ok_or_else(|| WorkflowStudioError::validation("invalid approval graph edges"))?
            .push(json!({"from":previous,"to":successor}));
    }
    Ok(())
}
