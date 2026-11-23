// SPDX-License-Identifier: LicenseRef-Proprietary
//! Record append-only review findings for frozen flagged events or daily summaries.
use console_platform_authz::{Principal, access::Level};
use console_platform_db::{
    idempotency::{self, IdempotencyClaim},
    with_audits,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use super::{list::Rules, projection, record};
use crate::{AccessError, AccessResult, AccessService};

const OPERATION: &str = "access_log_review.finding";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SummaryTarget {
    pub actor: Uuid,
    pub day: String,
    pub flag: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FollowUpInput {
    pub kind: String,
    #[serde(rename = "ref", default)]
    pub reference: Option<String>,
    #[serde(default)]
    pub closed: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FindingInput {
    #[serde(default)]
    pub event_id: Option<Uuid>,
    #[serde(default)]
    pub summary: Option<SummaryTarget>,
    pub disposition: String,
    #[serde(default)]
    pub outcome: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub follow_up: Option<FollowUpInput>,
}

fn target_key(value: &Value) -> String {
    if value["event_id"].is_null() {
        value["summary"].to_string()
    } else {
        value["event_id"].to_string()
    }
}

fn validate_input(body: &FindingInput) -> AccessResult<(Value, Value, Option<String>)> {
    if body.event_id.is_some() == body.summary.is_some() {
        return Err(AccessError::invalid(
            "target_required",
            "exactly one of event_id or summary is required",
        ));
    }
    if !matches!(body.disposition.as_str(), "confirmed" | "action_required") {
        return Err(AccessError::invalid(
            "disposition_invalid",
            "disposition must be confirmed or action_required",
        ));
    }
    let outcome = body
        .outcome
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    if body.disposition == "confirmed" && outcome.is_none() {
        return Err(AccessError::invalid(
            "outcome_required",
            "confirmed finding requires an outcome",
        ));
    }
    let follow_up = match &body.follow_up {
        None => json!({"kind": "none", "ref": null, "closed": true}),
        Some(f) => {
            let kind = f.kind.trim();
            if kind.is_empty() {
                return Err(AccessError::invalid(
                    "follow_up_invalid",
                    "follow_up.kind must not be blank",
                ));
            }
            if kind == "none" {
                if f.closed == Some(false) {
                    return Err(AccessError::invalid(
                        "follow_up_invalid",
                        "none follow-up cannot remain open",
                    ));
                }
                json!({"kind": "none", "ref": null, "closed": true})
            } else {
                let reference = f
                    .reference
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                json!({
                    "kind": kind,
                    "ref": reference,
                    "closed": f.closed.unwrap_or(false),
                })
            }
        }
    };
    let note = body
        .note
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let outcome_json = outcome.map_or(Value::Null, Value::String);
    Ok((outcome_json, follow_up, note))
}

/// Record or supersede one finding for a flagged event or daily summary in a started review.
///
/// # Errors
/// Cedar refusal, invalid period/input, missing or completed review, missing target, key reuse, or storage failure.
pub async fn finding(
    s: &AccessService,
    p: Principal,
    period: String,
    key: String,
    body: FindingInput,
) -> AccessResult<Value> {
    let actor = p.clone();
    let target = period.clone();
    let result = with_audits::<_, _, AccessError>(&s.pool, p.org_id, move |tx| {
        Box::pin(async move {
            record::require(tx, &p, Level::Approve).await?;
            let key = idempotency::validate_idempotency_key(Some(&key))
                .map_err(|m| AccessError::invalid("validation", m))?;
            let req_hash = json!({"period": period, "finding": body});
            match idempotency::claim_idempotency_key(tx, OPERATION, &key, &req_hash).await? {
                IdempotencyClaim::Replay(value) => return Ok((value, Vec::new())),
                IdempotencyClaim::Mismatch => {
                    return Err(console_kernel_core::KernelError::conflict(
                        idempotency::IDEMPOTENCY_KEY_REUSED,
                    )
                    .into());
                }
                IdempotencyClaim::Fresh => {}
            }
            super::list::period_day(&period)?;
            let (outcome_json, follow_up, note) = validate_input(&body)?;
            record::lock(tx, &p, &period).await?;
            let mut value = projection::in_tx(tx, &p, &period).await?;
            if value["started_at"].is_null() {
                return Err(AccessError::not_found(
                    "review_not_started",
                    "review has not started",
                ));
            }
            if value["state"] == "complete" {
                return Err(AccessError::conflict(
                    "review_already_complete",
                    "completed review cannot record findings",
                ));
            }
            let start_id: Uuid = serde_json::from_value(value["id"].clone())
                .map_err(AccessError::internal)?;
            let exists: bool = if let Some(event_id) = body.event_id {
                sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM audit_events a \
                     CROSS JOIN LATERAL jsonb_array_elements(a.after_snap#>'{evidence,flagged}') c \
                     CROSS JOIN LATERAL jsonb_array_elements(c) f \
                     WHERE a.org_id=$1 AND a.id=$2 AND f->>'event_id'=$3)",
                )
                .bind(p.org_id.as_uuid())
                .bind(start_id)
                .bind(event_id.to_string())
                .fetch_one(tx.as_mut())
                .await?
            } else if let Some(summary) = &body.summary {
                let summary_json = json!({
                    "actor": summary.actor,
                    "day": summary.day,
                    "flag": summary.flag,
                });
                sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM audit_events a \
                     CROSS JOIN LATERAL jsonb_array_elements(a.after_snap#>'{evidence,summaries}') s \
                     WHERE a.org_id=$1 AND a.id=$2 AND (s - 'count') = $3::jsonb)",
                )
                .bind(p.org_id.as_uuid())
                .bind(start_id)
                .bind(summary_json)
                .fetch_one(tx.as_mut())
                .await?
            } else {
                false
            };
            if !exists {
                return Err(AccessError::not_found(
                    "finding_target_not_found",
                    "flagged target not found in started review",
                ));
            }

            let now: OffsetDateTime = sqlx::query_scalar("SELECT now()")
                .fetch_one(tx.as_mut())
                .await?;
            let reason_due = if body.disposition == "action_required" && outcome_json.is_null() {
                Rules::load(tx.as_mut(), p.org_id)
                    .await?
                    .reason_due(tx.as_mut(), now)
                    .await?
                    .map(|dt| dt.format(&Rfc3339))
                    .transpose()
                    .map_err(AccessError::internal)?
            } else {
                None
            };

            let mut snap = json!({
                "disposition": body.disposition,
                "outcome": outcome_json,
                "follow_up": follow_up,
            });
            if let Some(event_id) = body.event_id {
                snap["event_id"] = json!(event_id);
            }
            if let Some(summary) = &body.summary {
                snap["summary"] = json!(summary);
            }
            if let Some(note) = note {
                snap["note"] = json!(note);
            }
            if let Some(due) = &reason_due {
                snap["reason_due"] = json!(due);
            }

            let audit = record::event(&p, &period, OPERATION)?.with_snapshots(None, Some(snap.clone()));
            let mut projected = snap;
            projected["id"] = json!(audit.id.as_uuid());
            projected["decided_by"] = json!(p.user_id.as_uuid());
            projected["decided_at"] = json!(now.format(&Rfc3339).map_err(AccessError::internal)?);

            let key_str = target_key(&projected);
            let findings = value["findings"]
                .as_array_mut()
                .ok_or_else(|| AccessError::internal("invalid findings"))?;
            findings.retain(|existing| target_key(existing) != key_str);
            findings.push(projected);

            let mut open = 0usize;
            let mut total = 0usize;
            for f in findings.iter() {
                if f["follow_up"]["kind"]
                    .as_str()
                    .is_some_and(|k| k != "none")
                {
                    total += 1;
                    if f["follow_up"]["closed"] != true {
                        open += 1;
                    }
                }
            }
            value["follow_up"] = json!({"open": open, "total": total});

            idempotency::complete_idempotency_key(tx, OPERATION, &key, &value).await?;
            console_platform_db::command_outcomes::set_result(tx, &value).await?;
            Ok((value, vec![audit]))
        })
    })
    .await;
    record::refusal(s, &actor, &target, result).await
}
