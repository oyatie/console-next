// SPDX-License-Identifier: LicenseRef-Proprietary
//! Tenant review starts and frozen pages. Evidence stays in the start audit row's
//! JSONB, using PostgreSQL's existing TOAST compression (no new store or codec).
//! Page-sized chunks avoid transferring/decoding a dense month's entire keyset.
//! Only this tenant-armed loader deserializes persisted flags; callers never supply them.
use console_kernel_core::AuditEvent;
use console_platform_authz::{
    Principal,
    access::{Domain, Level},
};
use console_platform_db::{
    idempotency::{self, IdempotencyClaim},
    with_audits,
};
use console_platform_request_context::audit_context::access_log::{AccessRecord, access_event};
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

pub use super::finding::{FindingInput, FollowUpInput, SummaryTarget, finding};
use super::list::{FlaggedEvent, prepare_in_tx, validate_limit};
pub use super::{
    complete::{CompleteInput, complete},
    projection::get,
};
use crate::{
    AccessError, AccessResult, AccessService,
    actor::{Actor, audit},
};

type StartRow = (Uuid, Option<Uuid>, OffsetDateTime, Value);
const OPERATION: &str = "access_log_review.start";
// Store at most one list-page of evidence per chunk.
const CHUNK_EVENTS: usize = super::MAX_PAGE_SIZE as usize;

pub(super) async fn require(
    tx: &mut Transaction<'_, Postgres>,
    p: &Principal,
    level: Level,
) -> AccessResult<()> {
    let actor = Actor::load(tx, p).await?;
    if actor.may(Domain::Audit, level, &actor.tenant()) {
        return Ok(());
    }
    if actor
        .subject
        .grants
        .iter()
        .any(|g| actor.may(Domain::Audit, level, &g.scope))
    {
        return Err(AccessError::forbidden(
            "scope_tenant_wide_only",
            "review requires tenant-wide access",
        ));
    }
    Err(AccessError::access_denied())
}

pub(super) fn event(p: &Principal, period: &str, action: &'static str) -> AccessResult<AuditEvent> {
    let mut event = audit(p, action, "access_log_review", *p.org_id.as_uuid())?;
    event.target_id = format!("tenant:{period}");
    Ok(event)
}

async fn load(
    tx: &mut Transaction<'_, Postgres>,
    p: &Principal,
    period: &str,
) -> AccessResult<Option<StartRow>> {
    Ok(sqlx::query_as(
        "SELECT id,actor,created_at,after_snap - 'evidence' FROM audit_events WHERE org_id=$1 \
         AND target_type='access_log_review' AND target_id=$2 AND action='access_log_review.start' \
         ORDER BY created_at,id LIMIT 1",
    )
    .bind(p.org_id.as_uuid())
    .bind(format!("tenant:{period}"))
    .fetch_optional(tx.as_mut())
    .await?)
}

pub(super) fn summary(row: StartRow) -> AccessResult<Value> {
    let (id, reviewer, at, mut snapshot) = row;
    let fields = snapshot
        .as_object_mut()
        .ok_or_else(|| AccessError::internal("invalid review evidence"))?;
    for key in ["evidence", "evidence_header", "chunk_ends"] {
        fields.remove(key);
    }
    Ok(
        json!({"id":id,"period":snapshot["period"],"scope":"tenant","reviewer":reviewer,
        "started_at":at.format(&time::format_description::well_known::Rfc3339).map_err(AccessError::internal)?,
        "reviewed_at":null,"due":snapshot["due"],"flags_seen":snapshot,"findings":[],"follow_up":{"open":0,"total":0},"state":"open"}),
    )
}

pub(super) async fn lock(
    tx: &mut Transaction<'_, Postgres>,
    p: &Principal,
    period: &str,
) -> AccessResult<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))")
        .bind(p.org_id.to_string())
        .bind(format!("tenant:{period}"))
        .execute(tx.as_mut())
        .await?;
    Ok(())
}

pub(super) async fn refusal<T>(
    s: &AccessService,
    p: &Principal,
    period: &str,
    result: AccessResult<T>,
) -> AccessResult<T> {
    if let Err(error) = &result
        && error.is_refusal()
    {
        let audit = event(p, period, "access_log_review.refused")?
            .with_snapshots(None, Some(json!({"code":error.code})));
        with_audits::<_, _, AccessError>(&s.pool, p.org_id, move |_tx| {
            Box::pin(async move { Ok(((), vec![audit])) })
        })
        .await?;
    }
    result
}

/// Start once per closed period; replays return that review's current projection.
/// # Errors
/// Tenant-wide Cedar refusal, invalid/open period, key reuse, or failed audit storage.
pub async fn start(
    s: &AccessService,
    p: Principal,
    period: String,
    key: String,
) -> AccessResult<Value> {
    let actor = p.clone();
    let target = period.clone();
    let result = with_audits::<_, _, AccessError>(&s.pool, p.org_id, move |tx| Box::pin(async move {
        require(tx, &p, Level::Approve).await?;
        let key = idempotency::validate_idempotency_key(Some(&key))
            .map_err(|message| AccessError::invalid("validation", message))?;
        match idempotency::claim_idempotency_key(tx, OPERATION, &key, &json!({"period":period})).await? {
            IdempotencyClaim::Replay(_) => return Ok((super::projection::in_tx(tx, &p, &period).await?, Vec::new())),
            IdempotencyClaim::Mismatch => return Err(console_kernel_core::KernelError::conflict(idempotency::IDEMPOTENCY_KEY_REUSED).into()),
            IdempotencyClaim::Fresh => {}
        }
        lock(tx, &p, &period).await?;
        let mut events = Vec::new();
        let value = if load(tx, &p, &period).await?.is_some() {
            super::projection::in_tx(tx, &p, &period).await?
        } else {
            let prepared = prepare_in_tx(tx.as_mut(), p.org_id, &period).await?;
            let due = prepared.due(tx.as_mut(), &period).await?;
            let flag_hash = prepared.flag_set_sha256()?;
            let mut evidence = serde_json::to_value(prepared).map_err(AccessError::internal)?;
            let mut rules = serde_json::Map::new();
            if let Some(versions) = evidence["rules"]["versions"].as_object() {
                for key in versions.keys() {
                    if let Some(name) = key.rsplit('.').next() {
                        rules.insert(key.clone(), evidence["rules"][name].clone());
                    }
                }
            }
            let flags = evidence["flagged"].take();
            let flags = flags.as_array().ok_or_else(|| AccessError::internal("invalid frozen keyset"))?;
            let chunks: Vec<_> = flags.chunks(CHUNK_EVENTS).collect();
            let ends: Vec<_> = chunks.iter().filter_map(|chunk| chunk.last()).collect();
            let summaries = evidence["summaries"].take();
            evidence["flagged"] = json!([]);
            evidence["summaries"] = json!([]);
            let snapshot = json!({"scope":"tenant","period":{"from":evidence["from"],"to":evidence["to"],"time_zone":evidence["rules"]["time_zone"]},
                "due":due.format(&time::format_description::well_known::Rfc3339).map_err(AccessError::internal)?,"events_total":evidence["totals"]["events"],"flagged_total":evidence["totals"]["flagged"],
                "by_flag":evidence["totals"]["by_flag"],"flag_set_sha256":flag_hash,"rules":rules,
                "evidence_header":evidence,"chunk_ends":ends,"evidence":{"flagged":chunks,"summaries":summaries}});
            let audit = event(&p, &period, OPERATION)?.with_snapshots(None, Some(snapshot.clone()));
            let created_at = sqlx::query_scalar("SELECT now()").fetch_one(tx.as_mut()).await?;
            let value = summary((*audit.id.as_uuid(), Some(*p.user_id.as_uuid()), created_at, snapshot))?;
            events.push(audit);
            let mut value = value;
            super::projection::apply_deadline(&mut value, due, created_at, false)?;
            value
        };
        idempotency::complete_idempotency_key(tx, OPERATION, &key, &value).await?;
        console_platform_db::command_outcomes::set_result(tx, &value).await?;
        Ok((value, events))
    })).await;
    refusal(s, &actor, &target, result).await
}

/// Page the persisted flagged set inside its owning tenant transaction.
/// # Errors
/// Cedar refusal, missing start, invalid limit, or failed read/access-record storage.
pub async fn frozen_page(
    s: &AccessService,
    p: Principal,
    period: String,
    cursor: Option<(OffsetDateTime, Uuid)>,
    limit: i64,
) -> AccessResult<Vec<FlaggedEvent>> {
    with_audits::<_, _, AccessError>(&s.pool, p.org_id, move |tx| Box::pin(async move {
        require(tx, &p, Level::View).await?;
        let mut row = load(tx, &p, &period).await?.ok_or_else(|| AccessError::not_found("review_not_started", "review has not started"))?;
        let ends: Vec<FlaggedEvent> = serde_json::from_value(row.3["chunk_ends"].take()).map_err(AccessError::internal)?;
        let start = cursor.map_or(0, |c| ends.partition_point(|r| (r.created_at,r.event_id)<=c));
        validate_limit(limit)?;
        let mut rows = Vec::new();
        let mut subjects = std::collections::BTreeSet::new();
        // Read the bounded terminal chunk even for an empty register. Empty and
        // populated months use the same indexed receipt and visibility path.
        for chunk in start..ends.len().max(start + 1) {
            let visible: Vec<(sqlx::types::Json<FlaggedEvent>, Option<Uuid>)> = sqlx::query_as(
                "SELECT entry.flag, event.actor FROM audit_events receipt \
                 CROSS JOIN LATERAL jsonb_array_elements((receipt.after_snap#>'{evidence,flagged}')->$3::int) \
                     WITH ORDINALITY AS entry(flag,position) \
                 JOIN ordinary_audit_events event ON event.org_id=$1 AND event.id=(entry.flag->>'event_id')::uuid \
                 WHERE receipt.org_id=$1 AND receipt.id=$2 ORDER BY entry.position"
            ).bind(p.org_id.as_uuid()).bind(row.0).bind(i32::try_from(chunk).map_err(AccessError::internal)?)
              .fetch_all(tx.as_mut()).await?;
            for (sqlx::types::Json(event), actor) in visible {
                if cursor.is_some_and(|after| (event.created_at, event.event_id) <= after) { continue; }
                rows.push(event);
                subjects.extend(actor);
                if rows.len() == limit as usize { break; }
            }
            if rows.len() == limit as usize { break; }
        }
        let subjects: Vec<_> = subjects.into_iter().collect();
        let audit = access_event(&p, AccessRecord {action:"access_log.review_read",target_type:"access_log",target_id:period.clone(),
            subject_ids:&subjects,reader_subject:Some(*p.user_id.as_uuid()),details:json!({"period":period,"flagged":true,"rows":rows.len()})})?;
        Ok((rows, vec![audit]))
    })).await
}
