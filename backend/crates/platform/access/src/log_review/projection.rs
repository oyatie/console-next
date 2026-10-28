// SPDX-License-Identifier: LicenseRef-Proprietary
//! The latest append-only findings and sign-off, scoped to one tenant period.
use console_platform_authz::{Principal, access::Level};
use console_platform_db::with_audits;
use console_platform_request_context::audit_context::access_log::{AccessRecord, access_event};
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use std::collections::BTreeSet;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use super::record::{require, summary};
use crate::{AccessError, AccessResult, AccessService};

pub(super) async fn in_tx(
    tx: &mut Transaction<'_, Postgres>,
    p: &Principal,
    period: &str,
) -> AccessResult<Value> {
    let now: OffsetDateTime = sqlx::query_scalar("SELECT now()")
        .fetch_one(tx.as_mut())
        .await?;
    let rows: Vec<(Uuid, Option<Uuid>, OffsetDateTime, String, Value)> = sqlx::query_as(
        "SELECT DISTINCT ON (action,COALESCE(after_snap->>'event_id',after_snap->>'summary','')) id,actor,created_at,action,\
         after_snap - 'evidence' - 'evidence_header' - 'chunk_ends' FROM audit_events \
         WHERE org_id=$1 AND target_type='access_log_review' AND target_id=$2 \
         AND action IN ('access_log_review.start','access_log_review.finding','access_log_review.complete') \
         ORDER BY action,COALESCE(after_snap->>'event_id',after_snap->>'summary',''),created_at DESC,id DESC")
        .bind(p.org_id.as_uuid()).bind(format!("tenant:{period}")).fetch_all(tx.as_mut()).await?;
    let mut start = None;
    let mut completed = None;
    let mut findings = Vec::new();
    let mut overdue = false;
    let mut open = 0;
    let mut total = 0;
    for (id, actor, at, action, mut snapshot) in rows {
        match action.as_str() {
            "access_log_review.start" => start = Some((id, actor, at, snapshot)),
            "access_log_review.complete" => completed = Some(at),
            _ => {
                if snapshot["follow_up"]["kind"]
                    .as_str()
                    .is_some_and(|k| k != "none")
                {
                    total += 1;
                    if snapshot["follow_up"]["closed"] != true {
                        open += 1;
                    }
                }
                if snapshot["disposition"] == "action_required"
                    && snapshot["outcome"].is_null()
                    && let Some(due) = snapshot["reason_due"].as_str()
                {
                    overdue |=
                        OffsetDateTime::parse(due, &Rfc3339).map_err(AccessError::internal)? < now;
                }
                snapshot["id"] = json!(id);
                snapshot["decided_by"] = json!(actor);
                snapshot["decided_at"] = json!(at.format(&Rfc3339).map_err(AccessError::internal)?);
                findings.push(snapshot);
            }
        }
    }
    let frozen_due = start.as_ref().and_then(|s| s.3["due"].as_str());
    let due = if let Some(due) = frozen_due {
        OffsetDateTime::parse(due, &Rfc3339).map_err(AccessError::internal)?
    } else {
        super::list::Rules::load(tx.as_mut(), p.org_id)
            .await?
            .due(tx.as_mut(), period)
            .await?
    };
    let mut value = if let Some(start) = start {
        summary(start)?
    } else {
        json!({"period":period,"scope":"tenant","reviewer":null,"started_at":null,
            "reviewed_at":null,"flags_seen":null,"findings":[],"follow_up":{"open":0,"total":0},"state":"not_started"})
    };
    apply_deadline(&mut value, due, now, overdue)?;
    if value["started_at"].is_null() {
        return Ok(value);
    }
    if completed.is_some() {
        value["state"] = json!("complete");
    }
    value["reviewed_at"] = json!(
        completed
            .map(|at| at.format(&Rfc3339))
            .transpose()
            .map_err(AccessError::internal)?
    );
    value["findings"] = json!(findings);
    value["follow_up"] = json!({"open":open,"total":total});
    Ok(value)
}

pub(super) fn apply_deadline(
    value: &mut Value,
    due: OffsetDateTime,
    now: OffsetDateTime,
    finding_overdue: bool,
) -> AccessResult<()> {
    value["due"] = json!(due.format(&Rfc3339).map_err(AccessError::internal)?);
    value["state"] = json!(if finding_overdue || due < now {
        "overdue"
    } else if value["started_at"].is_null() {
        "not_started"
    } else {
        "open"
    });
    Ok(())
}

/// Read the current review without exposing its frozen internal chunks.
/// # Errors
/// Cedar refusal, database failure, or failed 접속기록 storage.
pub async fn get(s: &AccessService, p: Principal, period: String) -> AccessResult<Value> {
    with_audits::<_, _, AccessError>(&s.pool, p.org_id, move |tx| {
        Box::pin(async move {
            require(tx, &p, Level::View).await?;
            super::list::period_day(&period)?;
            let value = in_tx(tx, &p, &period).await?;
            let subjects: BTreeSet<Uuid> = std::iter::once(&value["reviewer"])
                .chain(
                    value["findings"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|f| &f["decided_by"]),
                )
                .filter(|id| !id.is_null())
                .map(|id| serde_json::from_value(id.clone()).map_err(AccessError::internal))
                .collect::<AccessResult<_>>()?;
            let subjects: Vec<_> = subjects.into_iter().collect();
            let audit = access_event(
                &p,
                AccessRecord {
                    action: "access_log.review_read",
                    target_type: "access_log",
                    target_id: period.clone(),
                    subject_ids: &subjects,
                    reader_subject: Some(*p.user_id.as_uuid()),
                    details: json!({"period":period,"projection":"review"}),
                },
            )?;
            Ok((value, vec![audit]))
        })
    })
    .await
}
