// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{kst_now_and_today, payload_hash};
use crate::PgComplianceError;
use console_compliance_domain::rights::{
    DecideInput, Decision, Kind, Outcome, PostponeInput, RightsRequest, Status,
};
use console_kernel_core::{
    AuditAction, AuditEvent, KernelError, OrgId, Timestamp, TraceContext, UserId,
};
use console_platform_db::insert_audit_event;
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Transaction};
use std::collections::BTreeMap;
use time::Date;
use uuid::Uuid;

/// Canonical decision payload hash bound to `PRIVACY_REQUEST_DECIDE` step-up.
pub async fn decide_hash(pool: &PgPool, input: &DecideInput) -> Result<String, PgComplianceError> {
    let payload = serde_json::to_string(input).map_err(|e| KernelError::internal(e.to_string()))?;
    payload_hash(pool, payload).await
}

/// Canonical postponement payload hash bound to `PRIVACY_REQUEST_DECIDE` step-up.
pub async fn postpone_hash(
    pool: &PgPool,
    input: &PostponeInput,
) -> Result<String, PgComplianceError> {
    let payload = serde_json::to_string(input).map_err(|e| KernelError::internal(e.to_string()))?;
    payload_hash(pool, payload).await
}

async fn reason_codes_in_tx(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<BTreeMap<String, Vec<String>>, PgComplianceError> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT domain, code FROM system_reason_codes() WHERE domain LIKE 'privacy_%' ORDER BY domain, sort",
    )
    .fetch_all(tx.as_mut())
    .await?;
    let mut catalog: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (domain, code) in rows {
        catalog.entry(domain).or_default().push(code);
    }
    Ok(catalog)
}

/// Apply a final grant, partial grant, or refusal to one requested kind.
pub async fn apply_decide(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    id: Uuid,
    old_body: &Value,
    input: &DecideInput,
) -> Result<Value, PgComplianceError> {
    if input.outcome == Outcome::Postponed {
        return Err(PgComplianceError::Domain(
            KernelError::validation("postpone_not_allowed").with_code("postpone_not_allowed"),
        ));
    }
    apply_decision_internal(
        tx,
        org,
        actor,
        id,
        old_body,
        input.kind,
        Decision {
            outcome: input.outcome,
            reason: input.reason.clone(),
            note: input.note.clone(),
        },
        input.decided_on,
        "privacy_request.decided",
    )
    .await
}

/// Record a postponement on one requested kind.
pub async fn apply_postpone(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    id: Uuid,
    old_body: &Value,
    input: &PostponeInput,
) -> Result<Value, PgComplianceError> {
    apply_decision_internal(
        tx,
        org,
        actor,
        id,
        old_body,
        input.kind,
        Decision {
            outcome: Outcome::Postponed,
            reason: Some(input.reason.clone()),
            note: Some(input.note.clone()),
        },
        input.decided_on,
        "privacy_request.postponed",
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn apply_decision_internal(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    id: Uuid,
    old_body: &Value,
    kind: Kind,
    decision: Decision,
    decided_on: Option<Date>,
    audit_action: &'static str,
) -> Result<Value, PgComplianceError> {
    let mut request: RightsRequest = serde_json::from_value(old_body.clone())
        .map_err(|e| KernelError::internal(format!("stored privacy request invalid: {e}")))?;
    let (now, today) = kst_now_and_today(tx).await?;
    let on = decided_on.unwrap_or(today);
    let reason_codes = reason_codes_in_tx(tx).await?;
    let outcome = decision.outcome;
    let reason = decision.reason.clone();
    request.decide(kind, decision, on, today, &reason_codes)?;

    let updated =
        serde_json::to_value(&request).map_err(|e| KernelError::internal(e.to_string()))?;
    let mut new_body = old_body.clone();
    let kind_key = serde_json::to_value(kind)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .ok_or_else(|| KernelError::internal("invalid rights kind key"))?;
    if let (Some(dst), Some(src)) = (
        new_body
            .get_mut("kinds")
            .and_then(Value::as_object_mut)
            .and_then(|m| m.get_mut(&kind_key))
            .and_then(Value::as_object_mut),
        updated
            .get("kinds")
            .and_then(|m| m.get(&kind_key))
            .and_then(|k| k.get("decisions")),
    ) {
        dst.insert("decisions".to_owned(), src.clone());
    }
    new_body["status"] = json!(request.status());
    new_body["decided_by"] = json!(actor.as_uuid());
    let by_kind = new_body
        .as_object_mut()
        .ok_or_else(|| KernelError::internal("privacy request body must be an object"))?
        .entry("decided_by_kind")
        .or_insert_with(|| json!({}));
    if let Some(map) = by_kind.as_object_mut() {
        map.insert(kind_key, json!(actor.as_uuid()));
    }
    if request.status() == Status::Decided {
        new_body["decided_at"] = json!(now.unix_timestamp());
    }

    sqlx::query("UPDATE privacy_rights_requests SET body=$3 WHERE org_id=$1 AND id=$2")
        .bind(org.as_uuid())
        .bind(id)
        .bind(&new_body)
        .execute(tx.as_mut())
        .await?;

    let event = AuditEvent::new(
        Some(actor),
        AuditAction::new(audit_action)?,
        "privacy_rights_request",
        id.to_string(),
        TraceContext::generate(),
        Timestamp::now_utc(),
    )
    .with_org(org)
    .with_snapshots(
        Some(json!({
            "id": id,
            "status": old_body.get("status")
        })),
        Some(json!({
            "id": id,
            "kind": kind,
            "outcome": outcome,
            "reason": reason,
            "decided_on": on.to_string(),
            "status": request.status()
        })),
    );
    insert_audit_event(tx, &event).await?;
    console_platform_db::command_outcomes::set_result(tx, &new_body).await?;
    Ok(new_body)
}
