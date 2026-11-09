// SPDX-License-Identifier: LicenseRef-Proprietary
//! Decision hints enrich visible rows; commands always recheck live admission.
use super::*;
use console_action_inbox_application::decision::{DecisionFacts, DecisionPolicy};
use console_platform_authz::cedar_pbac::actions::org_change_step_decide;
use serde_json::{Value, json};
use std::collections::HashMap;
use uuid::Uuid;

pub(super) async fn load(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    principal: &Principal,
    ids: Vec<Uuid>,
    mut facts: HashMap<Uuid, org_change_step_decide::Facts>,
    policy: Option<DecisionPolicy>,
) -> Result<HashMap<Uuid, Value>, crate::error::AppError> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let org = principal.org_id;
    // Waiting rows can be approved already, or belong to a drafter without approval authority.
    let missing = ids
        .iter()
        .filter(|id| !facts.contains_key(id))
        .copied()
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        let waiting = console_orgchange_adapter_postgres::step_decision_facts_in_tx(
            tx,
            org,
            principal.user_id,
            console_orgchange_adapter_postgres::StepDecisionScope::Requests(missing),
        )
        .await
        .map_err(|e| crate::error::AppError::Internal(e.to_string()))?;
        facts.extend(waiting.into_iter().map(|row| (row.id, row.decision)));
    }
    let versions = sqlx::query_as::<_, (Uuid, OffsetDateTime, bool)>(
        "SELECT r.id, greatest(r.updated_at, max(s.decided_at)), count(s.id) > 0 FROM org_change_requests r \
                 LEFT JOIN org_change_approval_steps s ON s.org_id=r.org_id AND s.request_id=r.id \
                 WHERE r.org_id=$1 AND r.id=ANY($2) GROUP BY r.id, r.updated_at",
    )
    .bind(org.as_uuid())
    .bind(&ids)
    .fetch_all(tx.as_mut())
    .await?;
    Ok(versions
        .into_iter()
        .filter_map(|(id, timestamp, has_steps)| {
            let decision = org_change_step_decide::enforce(
                &principal.user_id.to_string(),
                &org.to_string(),
                &org.to_string(),
                *facts.get(&id)?,
            );
            let fields = json!(DecisionFacts::new(
                console_orgchange_domain::decision_version(timestamp, None),
                policy.and_then(|policy| policy.for_stored_steps(has_steps)),
                decision,
            ));
            Some((id, fields))
        })
        .collect())
}

pub(super) fn project(response: &mut Value) {
    for key in ["items", "upcoming"] {
        if let Some(rows) = response[key].as_array_mut() {
            for row in rows {
                if let Some(Value::Object(fields)) = row
                    .get_mut("context")
                    .and_then(Value::as_object_mut)
                    .and_then(|context| context.remove("decision"))
                    && let Some(row) = row.as_object_mut()
                {
                    row.extend(fields);
                }
            }
        }
    }
}
