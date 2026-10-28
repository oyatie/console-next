// SPDX-License-Identifier: LicenseRef-Proprietary
//! Completion uses the frozen set and the latest finding, under the start lock.
use console_platform_authz::{Principal, access::Level};
use console_platform_db::{
    idempotency::{self, IdempotencyClaim},
    with_audits,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use super::{projection, record};
use crate::{AccessError, AccessResult, AccessService, Refusal, StepUp, actor::verify_step_up};

const OPERATION: &str = "access_log_review.complete";

/// Sign off once, after every flagged event and required follow-up is resolved.
/// # Errors
/// Cedar refusal, missing/incomplete review, step-up failure, key reuse or storage failure.
pub async fn complete(
    s: &AccessService,
    p: Principal,
    period: String,
    key: String,
    step_up: Option<StepUp>,
) -> AccessResult<Value> {
    let state = s.clone();
    let actor = p.clone();
    let target = period.clone();
    let result = with_audits::<_, _, AccessError>(&s.pool, p.org_id, move |tx| Box::pin(async move {
        record::require(tx, &p, Level::Approve).await?;
        let key = idempotency::validate_idempotency_key(Some(&key)).map_err(|m| AccessError::invalid("validation",m))?;
        match idempotency::claim_idempotency_key(tx, OPERATION, &key, &json!({"period":period})).await? {
            IdempotencyClaim::Replay(value) => return Ok((value, Vec::new())),
            IdempotencyClaim::Mismatch => return Err(console_kernel_core::KernelError::conflict(idempotency::IDEMPOTENCY_KEY_REUSED).into()),
            IdempotencyClaim::Fresh => {}
        }
        super::list::period_day(&period)?;
        record::lock(tx, &p, &period).await?;
        let mut value = projection::in_tx(tx, &p, &period).await?;
        if value["state"] == "not_started" {
            return Err(AccessError::not_found("review_not_started","review has not started"));
        }
        let mut events = Vec::new();
        if value["state"] != "complete" {
            let flags: Vec<Uuid> = sqlx::query_scalar(
                "SELECT (f->>'event_id')::uuid FROM audit_events a \
                 CROSS JOIN LATERAL jsonb_array_elements(a.after_snap#>'{evidence,flagged}') c \
                 CROSS JOIN LATERAL jsonb_array_elements(c) f \
                 WHERE a.org_id=$1 AND a.id=$2")
                .bind(p.org_id.as_uuid()).bind(serde_json::from_value::<Uuid>(value["id"].clone()).map_err(AccessError::internal)?)
                .fetch_all(tx.as_mut()).await?;
            let findings: BTreeMap<Uuid, &Value> = value["findings"].as_array().ok_or_else(|| AccessError::internal("invalid findings"))?
                .iter().map(|f| Ok((serde_json::from_value(f["event_id"].clone()).map_err(AccessError::internal)?, f))).collect::<AccessResult<_>>()?;
            let mut open = Vec::new();
            let mut outcomes = BTreeMap::<String, usize>::new();
            for id in &flags {
                if let Some(finding) = findings.get(id) {
                    if !matches!(finding["disposition"].as_str(), Some("confirmed" | "action_required"))
                        || (finding["disposition"] == "action_required" && finding["outcome"].is_null())
                        || (finding["follow_up"]["kind"] != "none" && finding["follow_up"]["closed"] != true) {
                        open.push(*id);
                    }
                    if let Some(outcome) = finding["outcome"].as_str() { *outcomes.entry(outcome.into()).or_default() += 1; }
                } else { open.push(*id); }
            }
            if !open.is_empty() {
                return Err(AccessError { details:Some(Box::new(json!({"open_event_ids":open}))), ..AccessError::conflict("review_incomplete","flagged events or follow-ups remain open") });
            }
            verify_step_up(&state, &p, step_up).await.map_err(|mut e| {
                if e.kind == Refusal::StepUpRequired { e.code = "step_up_required"; }
                e
            })?;
            let at: OffsetDateTime = sqlx::query_scalar("SELECT now()").fetch_one(tx.as_mut()).await?;
            value["state"] = json!("complete");
            value["reviewed_at"] = json!(at.format(&Rfc3339).map_err(AccessError::internal)?);
            events.push(record::event(&p, &period, OPERATION)?.with_snapshots(None, Some(json!({"findings_total":flags.len(),"by_outcome":outcomes,"follow_ups_open":0}))));
        }
        idempotency::complete_idempotency_key(tx, OPERATION, &key, &value).await?;
        Ok((value, events))
    })).await;
    record::refusal(s, &actor, &target, result).await
}
