// SPDX-License-Identifier: LicenseRef-Proprietary
use super::WorkflowStudioError;
use console_kernel_core::KernelError;
use console_platform_db::{DbError, with_org_conn};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
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
) -> Result<(i32, Value, bool), WorkflowStudioError> {
    let row = with_org_conn::<
        _,
        Option<(
            String,
            Option<Value>,
            Option<i32>,
            Option<String>,
            Option<i32>,
            bool,
        )>,
        DbError,
    >(pool, org, move |tx| {
        Box::pin(async move {
            let row = sqlx::query(
                "SELECT d.status, v.definition, v.version, v.status AS version_status, \
                        d.active_version, COALESCE(v.allow_approval_line_override, true) AS allow_override \
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
            )))
        })
    })
    .await
    .map_err(WorkflowStudioError::from)?;

    let Some((status, definition, version, version_status, active_version, allow_override)) = row
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
    Ok((version, definition, allow_override))
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
    for step in overrides {
        if step.assignee_role_key.trim().is_empty() {
            return Err(WorkflowStudioError::validation(
                "approval_line_overrides[].assignee_role_key must not be empty",
            ));
        }
    }

    if let Some(nodes) = definition.get_mut("nodes").and_then(Value::as_array_mut) {
        let required_keys: Vec<String> = nodes
            .iter()
            .filter(|n| {
                let kind = n
                    .get("kind")
                    .or_else(|| n.get("type"))
                    .and_then(Value::as_str);
                let is_human = matches!(kind, Some("human_task" | "HUMAN_TASK"));
                let is_req = n
                    .get("required")
                    .and_then(Value::as_bool)
                    .unwrap_or(required_approval_line);
                is_human && is_req
            })
            .filter_map(|n| {
                n.get("key")
                    .or_else(|| n.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .collect();

        let supplied_keys: Vec<&str> = overrides
            .iter()
            .filter_map(|s| s.node_key.as_deref())
            .collect();
        if !supplied_keys.is_empty() {
            for req_key in &required_keys {
                if !supplied_keys.contains(&req_key.as_str()) {
                    return Err(WorkflowStudioError::validation(
                        "required_approval_step_removed: required approval steps cannot be removed",
                    ));
                }
            }
        }

        for step in overrides {
            if let Some(key) = step.node_key.as_deref()
                && let Some(node) = nodes.iter_mut().find(|n| {
                    n.get("key").or_else(|| n.get("id")).and_then(Value::as_str) == Some(key)
                })
                && let Some(obj) = node.as_object_mut()
            {
                obj.insert(
                    "assignee_role_key".to_owned(),
                    json!(step.assignee_role_key.trim()),
                );
                if let Some(title) = step
                    .title
                    .as_deref()
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                {
                    obj.insert("title".to_owned(), json!(title));
                }
            }
        }
    }

    if !context_payload.is_object() {
        *context_payload = json!({});
    }
    if let Some(ctx) = context_payload.as_object_mut() {
        ctx.insert("approval_line_overrides".to_owned(), json!(overrides));
    }
    Ok(())
}
