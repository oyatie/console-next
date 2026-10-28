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

use super::list::{FlaggedEvent, Prepared, page_in_tx, prepare_in_tx};
use crate::{
    AccessError, AccessResult, AccessService,
    actor::{Actor, audit},
};

type StartRow = (Uuid, Option<Uuid>, OffsetDateTime, Value);
const OPERATION: &str = "access_log_review.start";
// The list contract caps a page at 200; any page intersects at most two chunks.
const CHUNK_EVENTS: usize = super::MAX_PAGE_SIZE as usize;

async fn require(
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

fn event(p: &Principal, period: &str, action: &'static str) -> AccessResult<AuditEvent> {
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

fn summary(row: StartRow) -> AccessResult<Value> {
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
        "reviewed_at":null,"flags_seen":snapshot,"findings":[],"state":"open"}),
    )
}

/// Start once per closed period, replaying the same outcome for the same key.
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
            IdempotencyClaim::Replay(value) => return Ok((value, Vec::new())),
            IdempotencyClaim::Mismatch => return Err(console_kernel_core::KernelError::conflict(idempotency::IDEMPOTENCY_KEY_REUSED).into()),
            IdempotencyClaim::Fresh => {}
        }
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))")
            .bind(p.org_id.to_string()).bind(format!("tenant:{period}"))
            .execute(tx.as_mut()).await?;
        let mut events = Vec::new();
        let value = if let Some(row) = load(tx, &p, &period).await? {
            summary(row)?
        } else {
            let prepared = prepare_in_tx(tx.as_mut(), p.org_id, &period).await?;
            let flag_hash = prepared.flag_set_sha256()?;
            let mut evidence = serde_json::to_value(prepared).map_err(AccessError::internal)?;
            let mut rules = serde_json::Map::new();
            for key in console_settings_domain::SettingKey::ALL.iter().filter(|key| key.as_str().starts_with("access_log_review.flag.") || key.as_str().starts_with("access_log_review.off_hours.") || matches!(key, console_settings_domain::SettingKey::AccessLogReviewTimeZone | console_settings_domain::SettingKey::AccessLogReviewReasonDueBusinessDays)) {
                if let Some(name) = key.as_str().rsplit('.').next() {
                    rules.insert(key.as_str().into(), evidence["rules"][name].clone());
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
                "events_total":evidence["totals"]["events"],"flagged_total":evidence["totals"]["flagged"],
                "by_flag":evidence["totals"]["by_flag"],"flag_set_sha256":flag_hash,"rules":rules,
                "evidence_header":evidence,"chunk_ends":ends,"evidence":{"flagged":chunks,"summaries":summaries}});
            let audit = event(&p, &period, OPERATION)?.with_snapshots(None, Some(snapshot.clone()));
            let created_at = sqlx::query_scalar("SELECT now()").fetch_one(tx.as_mut()).await?;
            let value = summary((*audit.id.as_uuid(), Some(*p.user_id.as_uuid()), created_at, snapshot))?;
            events.push(audit);
            value
        };
        idempotency::complete_idempotency_key(tx, OPERATION, &key, &value).await?;
        Ok((value, events))
    })).await;
    if let Err(error) = &result
        && error.is_refusal()
    {
        let audit = event(&actor, &target, "access_log_review.refused")?
            .with_snapshots(None, Some(json!({"code":error.code})));
        with_audits::<_, _, AccessError>(&s.pool, actor.org_id, move |_tx| {
            Box::pin(async move { Ok(((), vec![audit])) })
        })
        .await?;
    }
    result
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
        let chunks: Value = sqlx::query_scalar("SELECT jsonb_build_array((after_snap#>'{evidence,flagged}')->$3::int,(after_snap#>'{evidence,flagged}')->($3::int+1)) FROM audit_events WHERE org_id=$1 AND id=$2")
            .bind(p.org_id.as_uuid()).bind(row.0).bind(i32::try_from(start).map_err(AccessError::internal)?)
            .fetch_one(tx.as_mut()).await?;
        let flags: Vec<Value> = chunks.as_array().ok_or_else(|| AccessError::internal("invalid frozen chunks"))?
            .iter().filter_map(Value::as_array).flatten().cloned().collect();
        let mut header = row.3["evidence_header"].take();
        header["flagged"] = json!(flags);
        let prepared: Prepared = serde_json::from_value(header).map_err(AccessError::internal)?;
        let rows = page_in_tx(tx.as_mut(), &prepared, cursor, limit, true).await?;
        let ids: Vec<_> = rows.iter().map(|r| r.event_id).collect();
        let subjects: Vec<Uuid> = sqlx::query_scalar("SELECT DISTINCT actor FROM audit_events WHERE org_id=$1 AND id=ANY($2) AND actor IS NOT NULL ORDER BY actor")
            .bind(p.org_id.as_uuid()).bind(ids).fetch_all(tx.as_mut()).await?;
        let audit = access_event(&p, AccessRecord {action:"access_log.review_read",target_type:"access_log",target_id:period.clone(),
            subject_ids:&subjects,reader_subject:Some(*p.user_id.as_uuid()),details:json!({"period":period,"flagged":true,"rows":rows.len()})})?;
        Ok((rows, vec![audit]))
    })).await
}
