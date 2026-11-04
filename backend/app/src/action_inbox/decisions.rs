// SPDX-License-Identifier: LicenseRef-Proprietary
//! Decision hints enrich visible rows; commands always recheck live admission.
use super::*;
use console_platform_authz::cedar_pbac::actions::org_change_step_decide;
use serde_json::{Value, json};
use std::collections::HashMap;
use uuid::Uuid;

pub(super) async fn project(
    sources: &PgActionInboxSources,
    response: &mut Value,
) -> Result<(), KernelError> {
    let ids: Vec<Uuid> = ["items", "upcoming"]
        .into_iter()
        .flat_map(|key| response[key].as_array().into_iter().flatten())
        .filter(|row| {
            matches!(
                row["kind"].as_str(),
                Some("org_change_approve" | "org_change_waiting")
            )
        })
        .filter_map(|row| {
            row["id"]
                .as_str()?
                .strip_prefix("org_change:")?
                .parse()
                .ok()
        })
        .collect();
    if ids.is_empty() {
        return Ok(());
    }
    let principal = sources.principal.clone();
    let org = principal.org_id;
    let decisions = console_platform_db::with_org_conn::<_, _, crate::error::AppError>(
        &sources.pool, org, move |tx| Box::pin(async move {
            let facts = console_orgchange_adapter_postgres::step_decision_facts_in_tx(
                tx, org, principal.user_id, console_orgchange_adapter_postgres::StepDecisionScope::Requests(ids.clone()),
            ).await.map_err(|e| crate::error::AppError::Internal(e.to_string()))?;
            let versions: HashMap<Uuid, OffsetDateTime> = sqlx::query_as::<_, (Uuid, OffsetDateTime)>(
                "SELECT r.id, greatest(r.updated_at, max(s.decided_at)) FROM org_change_requests r \
                 LEFT JOIN org_change_approval_steps s ON s.org_id=r.org_id AND s.request_id=r.id \
                 WHERE r.org_id=$1 AND r.id=ANY($2) GROUP BY r.id, r.updated_at",
            ).bind(org.as_uuid()).bind(&ids).fetch_all(tx.as_mut()).await?.into_iter().collect();
            Ok(facts.into_iter().filter_map(|row| {
                let id = row.id;
                let timestamp = versions.get(&id)?;
                let decision = org_change_step_decide::enforce(
                    &principal.user_id.to_string(), &org.to_string(), &org.to_string(), row.decision,
                );
                let mut fields = json!({
                    "version": console_orgchange_domain::decision_version(*timestamp, None),
                    "can_decide": decision.is_ok(),
                });
                if let Err(error) = decision {
                    fields["cannot_reason"] = json!(error.code.unwrap_or("forbidden"));
                }
                Some((format!("org_change:{id}"), fields))
            }).collect::<HashMap<_, _>>())
        }),
    ).await.map_err(|e| source_failure("org_change_decisions", e))?;
    for key in ["items", "upcoming"] {
        if let Some(rows) = response[key].as_array_mut() {
            for row in rows {
                if let Some(fields) = row["id"].as_str().and_then(|id| decisions.get(id))
                    && let (Some(row), Some(fields)) = (row.as_object_mut(), fields.as_object())
                {
                    row.extend(fields.clone());
                }
            }
        }
    }
    Ok(())
}
