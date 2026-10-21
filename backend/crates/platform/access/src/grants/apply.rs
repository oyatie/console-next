//! Apply the validated receipt and seal its outcome in one transaction.
use super::{check_all, digest, store};
use crate::AccessService;
use crate::actor::{Actor, audit, validate_reason, verify_step_up};
use crate::dto::GrantOut;
use crate::error::{AccessError, AccessResult};
use crate::grant_types::{Apply, Op};
use crate::grants_store::{ListFilter, NewGrant};
use console_kernel_core::TenantPhase;
use console_platform_authz::Principal;
use console_platform_authz::access::{Level, load_tenant_phase};
use console_platform_db::with_audits;
use serde_json::{Value, json};
use sqlx::Row;
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, serde::Serialize)]
pub struct ApplyOutcome {
    pub items: Vec<GrantOut>,
    pub operation_id: Uuid,
}
pub async fn apply(s: &AccessService, p: Principal, body: Apply) -> AccessResult<ApplyOutcome> {
    verify_step_up(s, &p, body.step_up).await?;
    let now = OffsetDateTime::now_utc();
    let event = audit(
        &p,
        "access.grants.apply",
        "access_grant_receipts",
        body.receipt_id,
    )?;
    let operation_id = console_platform_db::command_context::current()
        .and_then(|c| c.command_id)
        .unwrap_or_else(Uuid::new_v4);
    let grants = with_audits::<_, _, AccessError>(&s.pool, p.org_id, move |tx| {
        Box::pin(async move {
            let actor = Actor::load(tx, &p).await?;
            actor.require_some_access(Level::Edit)?;
            let org = actor.org();
            sqlx::query("SELECT set_config('app.current_actor', $1, true)")
                .bind(actor.id().to_string())
                .execute(tx.as_mut())
                .await?;
            let row = sqlx::query(
                "SELECT actor_id, digest, request, refused, expires_at, used_at
                   FROM access_grant_receipts WHERE org_id = $1 AND id = $2 FOR UPDATE",
            )
            .bind(org.as_uuid())
            .bind(body.receipt_id)
            .fetch_optional(tx.as_mut())
            .await?
            .filter(|r| {
                r.try_get::<Uuid, _>("actor_id")
                    .is_ok_and(|a| a == actor.id())
            })
            .ok_or_else(|| {
                AccessError::not_found("receipt_not_found", "no such preview receipt")
            })?;
            if row
                .try_get::<Option<OffsetDateTime>, _>("used_at")?
                .is_some()
            {
                let original_operation_id: Option<Uuid> = sqlx::query_scalar("SELECT command_id FROM audit_events WHERE org_id=$1 AND actor=$2 AND target_type='access_grant_receipts' AND target_id=$3 AND action='access.grants.apply' AND outcome='ALLOWED' ORDER BY created_at DESC,id DESC LIMIT 1")
                    .bind(org.as_uuid()).bind(actor.id()).bind(body.receipt_id.to_string()).fetch_optional(tx.as_mut()).await?.flatten();
                return Err(AccessError { original_operation_id, ..AccessError::conflict(
                    "receipt_used",
                    "this preview was already applied",
                ) });
            }
            if row.try_get::<OffsetDateTime, _>("expires_at")? <= now {
                return Err(AccessError::conflict("receipt_expired", "preview again"));
            }
            if row.try_get::<i32, _>("refused")? > 0 {
                return Err(AccessError::conflict(
                    "preview_has_refusals",
                    "remove the refused items and preview again",
                ));
            }
            let request: Value = row.try_get("request")?;
            let ops: Vec<Op> =
                serde_json::from_value(request["ops"].clone()).map_err(AccessError::internal)?;
            let reason = request["reason_code"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            let note = request["reason_note"].as_str().map(str::to_owned);
            validate_reason(tx, org, &reason, note.as_deref()).await?;
            let phase = load_tenant_phase(tx, org).await?;
            let checked = check_all(tx, &actor, phase, now, &ops).await?;
            let items: Vec<Value> = checked.iter().map(|c| c.item.clone()).collect();
            if digest(&request, &items) != row.try_get::<String, _>("digest")? {
                return Err(AccessError::conflict(
                    "preview_stale",
                    "something changed since the preview; preview again",
                ));
            }
            let mode = if phase == TenantPhase::Setup {
                "SETUP"
            } else {
                "OPERATING"
            };
            let mut ids = Vec::with_capacity(ops.len());
            for (op, c) in ops.iter().zip(&checked) {
                match op {
                    Op::Grant { grant_id, .. } => {
                        let row = c
                            .write
                            .as_ref()
                            .ok_or_else(|| AccessError::internal("grant without its row"))?;
                        let new = NewGrant {
                            row,
                            change_mode: mode,
                            reason_code: &reason,
                            reason_note: note.as_deref(),
                            granted_by: actor.id(),
                        };
                        store::insert(tx, org, &new).await?;
                        ids.push(*grant_id);
                    }
                    Op::Revoke { grant_id } => {
                        store::revoke(tx, org, *grant_id, actor.id()).await?;
                        ids.push(*grant_id);
                    }
                    Op::SetEnd { grant_id, valid_to } => {
                        store::set_end(tx, org, *grant_id, *valid_to).await?;
                        ids.push(*grant_id);
                    }
                }
            }
            sqlx::query(
                "UPDATE access_grant_receipts SET used_at = now() WHERE org_id = $1 AND id = $2",
            )
            .bind(org.as_uuid())
            .bind(body.receipt_id)
            .execute(tx.as_mut())
            .await?;
            let filter = ListFilter {
                ids: Some(ids),
                include_ended: true,
                ..ListFilter::default()
            };
            let items=store::list(tx, org, &filter, phase, now).await?;
            let outcome=ApplyOutcome { items, operation_id };
            console_platform_db::command_outcomes::set_result(tx,&serde_json::to_value(&outcome).map_err(AccessError::internal)?).await?;
            Ok((outcome, vec![event.with_snapshots(None, Some(json!({"reason_code":reason})))]))
        })
    })
    .await?;
    Ok(grants)
}
