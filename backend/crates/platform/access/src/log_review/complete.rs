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
        if value["started_at"].is_null() {
            return Err(AccessError::not_found("review_not_started","review has not started"));
        }
        let mut events = Vec::new();
        if value["state"] != "complete" {
            let targets: Vec<Value> = sqlx::query_scalar(
                "SELECT jsonb_build_object('event_id',f->'event_id') FROM audit_events a \
                 CROSS JOIN LATERAL jsonb_array_elements(a.after_snap#>'{evidence,flagged}') c \
                 CROSS JOIN LATERAL jsonb_array_elements(c) f \
                 WHERE a.org_id=$1 AND a.id=$2 \
                 UNION ALL SELECT jsonb_build_object('summary',s - 'count') FROM audit_events a \
                 CROSS JOIN LATERAL jsonb_array_elements(a.after_snap#>'{evidence,summaries}') s \
                 WHERE a.org_id=$1 AND a.id=$2")
                .bind(p.org_id.as_uuid()).bind(serde_json::from_value::<Uuid>(value["id"].clone()).map_err(AccessError::internal)?)
                .fetch_all(tx.as_mut()).await?;
            let findings: BTreeMap<String, &Value> = value["findings"].as_array().ok_or_else(|| AccessError::internal("invalid findings"))?
                .iter().map(|f| (target_key(f), f)).collect();
            let mut open = Vec::new();
            let mut open_summaries = Vec::new();
            let mut outcomes = BTreeMap::<String, usize>::new();
            for target in &targets {
                let finding = findings.get(&target_key(target));
                if finding.is_none_or(|f| !resolved(f)) {
                    if target["event_id"].is_null() { open_summaries.push(target["summary"].clone()); }
                    else { open.push(target["event_id"].clone()); }
                }
                if let Some(outcome) = finding.and_then(|f| f["outcome"].as_str()) {
                    *outcomes.entry(outcome.into()).or_default() += 1;
                }
            }
            if !open.is_empty() || !open_summaries.is_empty() {
                let mut details = json!({"open_event_ids":open});
                if !open_summaries.is_empty() { details["open_summaries"] = json!(open_summaries); }
                return Err(AccessError { details:Some(Box::new(details)), ..AccessError::conflict("review_incomplete","flagged events or summaries remain open") });
            }
            verify_step_up(&state, &p, step_up).await.map_err(|mut e| {
                if e.kind == Refusal::StepUpRequired { e.code = "step_up_required"; }
                e
            })?;
            let at: OffsetDateTime = sqlx::query_scalar("SELECT now()").fetch_one(tx.as_mut()).await?;
            value["state"] = json!("complete");
            value["reviewed_at"] = json!(at.format(&Rfc3339).map_err(AccessError::internal)?);
            events.push(record::event(&p, &period, OPERATION)?.with_snapshots(None, Some(json!({"findings_total":targets.len(),"by_outcome":outcomes,"follow_ups_open":0}))));
        }
        idempotency::complete_idempotency_key(tx, OPERATION, &key, &value).await?;
        Ok((value, events))
    })).await;
    record::refusal(s, &actor, &target, result).await
}

fn target_key(value: &Value) -> String {
    if value["event_id"].is_null() {
        value["summary"].to_string()
    } else {
        value["event_id"].to_string()
    }
}

fn resolved(finding: &Value) -> bool {
    matches!(
        finding["disposition"].as_str(),
        Some("confirmed" | "action_required")
    ) && (finding["disposition"] != "action_required" || !finding["outcome"].is_null())
        && (finding["follow_up"]["kind"] == "none" || finding["follow_up"]["closed"] == true)
}
