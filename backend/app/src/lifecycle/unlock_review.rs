// SPDX-License-Identifier: LicenseRef-Proprietary
//! A consumed sole-holder exception stays in the inbox until an entitled reviewer acknowledges it.
use super::{LifecycleError, LifecycleState};
use axum::{
    Extension, Json,
    extract::{Path, State},
};
use console_action_inbox_application::{ActionInboxLink, ActionInboxSourceItem};
use console_identity_adapter_postgres::second_person::{HolderCapability, PgHolderResolver};
use console_kernel_core::{AuditAction, AuditEvent, KernelError, OrgId, TraceContext};
use console_platform_authz::{
    Feature, Principal, cedar_pbac::actions::period_unlock_review::Reviewers,
};
use console_platform_db::with_audits;
use serde_json::{Value, json};
use time::OffsetDateTime;
use uuid::Uuid;

// One outstanding-review predicate for inbox delivery and the lock's current warning.
macro_rules! pending_review {
    () => {
        "e.rule_code='PERIOD_UNLOCK_SOLE_HOLDER' AND e.subject_type='PERIOD_LOCK' \
         AND e.fallback_kind='SOLE_HOLDER' AND e.status='RECORDED' AND e.consumed_at IS NOT NULL \
         AND NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.org_id=e.org_id AND a.target_type='governed_exception' AND a.target_id=e.id::text AND a.action='exception.review')"
    };
}
pub(super) use pending_review;

async fn load_reviewers(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: OrgId,
) -> Result<Reviewers, LifecycleError> {
    let accounts: Vec<_> = PgHolderResolver {
        tx,
        org,
        capability: HolderCapability::Feature {
            feature: Feature::PeriodLockManage,
            branch: None,
        },
        exclude_account: None,
        exclude_employee: None,
        include_ops: true,
        now: OffsetDateTime::now_utc(),
    }
    .resolve_at_most(usize::MAX)
    .await?
    .into_iter()
    .collect();
    let people = sqlx::query_as::<_, (Uuid, Uuid)>(
        "SELECT id,COALESCE(person_id,id) FROM users WHERE org_id=$1 AND id=ANY($2)",
    )
    .bind(org.as_uuid())
    .bind(accounts)
    .fetch_all(tx.as_mut())
    .await?;
    Ok(Reviewers::new(org, people.into_iter().collect()))
}

pub(super) async fn items(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    principal: &Principal,
    as_of: OffsetDateTime,
) -> Result<Vec<ActionInboxSourceItem>, LifecycleError> {
    type Row = (
        Uuid,
        Uuid,
        Uuid,
        Option<Uuid>,
        String,
        Option<String>,
        OffsetDateTime,
        OffsetDateTime,
        String,
        time::Date,
        time::Date,
        String,
        Option<Value>,
    );
    let rows: Vec<Row> = sqlx::query_as(concat!(
        "SELECT e.id,e.subject_id,e.requested_by,u.person_id,e.reason_code,e.note,e.review_due_at,e.consumed_at,l.domain,l.period_start,l.period_end,u.display_name, \
         (SELECT jsonb_build_object('system',false,'label_ko',c.label_ko,'label_en',c.label_en) FROM reason_codes c WHERE c.org_id=e.org_id AND c.domain='period_unlock' AND c.code=e.reason_code) \
         FROM governed_exceptions e JOIN period_locks l ON l.org_id=e.org_id AND l.id=e.subject_id JOIN person_accounts_current u ON u.org_id=e.org_id AND u.id=e.requested_by \
         WHERE e.org_id=$1 AND e.consumed_at<=$2 AND ", pending_review!(), " ORDER BY e.consumed_at,e.id"))
        .bind(principal.org_id.as_uuid()).bind(as_of).fetch_all(tx.as_mut()).await?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let reviewers = load_reviewers(tx, principal.org_id).await?;
    let mut items = Vec::new();
    for (
        id,
        lock,
        requester,
        person,
        reason_code,
        note,
        due,
        created_at,
        domain,
        start,
        end,
        name,
        reason_entry,
    ) in rows
    {
        if !reviewers.allows(*principal.user_id.as_uuid(), requester, person)? {
            continue;
        }
        items.push(ActionInboxSourceItem {
            id: format!("period_unlock:{id}"), kind: "period_unlock".into(), ref_code: String::new(), title: name.clone(), site: None, who: None,
            due: Some(due), submitted: Some(created_at), created_at,
            links: vec![ActionInboxLink { kind: "period_lock".into(), id: lock.to_string(), label: None }],
            context: Some(json!({"unlock": {"domain":domain,"periodStart":start.to_string(),"periodEnd":end.to_string(),"requester":name,"reason_code":reason_code,"reason_entry":reason_entry,"exceptionId":id}, "reason":note.unwrap_or_default()})),
        });
    }
    Ok(items)
}

// console-gate: state-changing-handler
pub(super) async fn acknowledge(
    State(state): State<LifecycleState>,
    Extension(principal): Extension<Principal>,
    Path((lock, exception)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>, LifecycleError> {
    let org = principal.org_id;
    let actor = principal.user_id;
    let response = with_audits::<_, _, LifecycleError>(&state.pool, org, move |tx| Box::pin(async move {
        let reviewers = load_reviewers(tx, org).await?;
        // Refuse unentitled callers before disclosing whether this exception exists.
        if !reviewers.allows(*actor.as_uuid(), Uuid::nil(), None)? {
            return Err(KernelError::forbidden("close entitlement is required to review an unlock").into());
        }
        let record: Option<(Uuid, Option<Uuid>)> = sqlx::query_as(
            "SELECT e.requested_by,u.person_id FROM governed_exceptions e JOIN users u ON u.org_id=e.org_id AND u.id=e.requested_by \
             WHERE e.org_id=$1 AND e.id=$2 AND e.subject_id=$3 AND e.subject_type='PERIOD_LOCK' AND e.rule_code='PERIOD_UNLOCK_SOLE_HOLDER' \
             AND e.status='RECORDED' AND e.fallback_kind='SOLE_HOLDER' AND e.consumed_at IS NOT NULL FOR UPDATE OF e")
            .bind(org.as_uuid()).bind(exception).bind(lock).fetch_optional(tx.as_mut()).await?;
        let (requester, person) = record.ok_or_else(|| KernelError::not_found("unlock review not found"))?;
        if !reviewers.allows(*actor.as_uuid(), requester, person)? {
            return Err(KernelError::forbidden("another close authority must review this unlock").into());
        }
        let reviewed: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM audit_events WHERE org_id=$1 AND target_type='governed_exception' AND target_id=$2 AND action='exception.review')")
            .bind(org.as_uuid()).bind(exception.to_string()).fetch_one(tx.as_mut()).await?;
        let events = if reviewed { Vec::new() } else { vec![AuditEvent::new(Some(actor), AuditAction::new("exception.review")?, "governed_exception", exception.to_string(), TraceContext::generate(), OffsetDateTime::now_utc())
            .with_org(org).with_snapshots(None, Some(json!({"lockId":lock,"acknowledged":true})))] };
        Ok((json!({"id":exception,"status":"REVIEWED"}), events))
    })).await?;
    Ok(Json(response))
}

#[cfg(test)]
#[path = "unlock_review_tests.rs"]
mod tests;
