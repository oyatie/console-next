//! Grants: list, preview a batch (single-use receipt), apply it all or nothing.
//! 권한 부여 is high-risk (decision #26): apply needs a fresh passkey step-up
//! and a `role_change` reason; the preview re-runs inside the apply
//! transaction and any difference refuses with `preview_stale`.

use std::collections::BTreeSet;

use console_kernel_core::TenantPhase;
use console_platform_authz::Principal;
use console_platform_authz::access::{Domain, Level, load_tenant_phase};
use console_platform_db::{with_audit, with_org_conn};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::AccessService;
use crate::actor::{Actor, audit, node_path, validate_reason};
use crate::dto::GrantOut;
use crate::error::{AccessError, AccessResult};
use crate::grant_ops::{Checked, check};
use crate::grant_types::Op;
pub use crate::grant_types::{Apply, Batch, GrantQuery};
use crate::grants_store::{self as store, ListFilter};

/// How long a preview receipt stays usable (same as the policy-assignment receipts).
const RECEIPT_TTL: Duration = Duration::minutes(10);
const MAX_BATCH: usize = 200;

pub async fn list(s: &AccessService, p: Principal, q: GrantQuery) -> AccessResult<Vec<GrantOut>> {
    let grants = with_org_conn::<_, _, AccessError>(&s.pool, p.org_id, move |tx| {
        Box::pin(async move {
            let actor = Actor::load(tx, &p).await?;
            actor.require_some_access(Level::View)?;
            let phase = load_tenant_phase(tx, p.org_id).await?;
            let filter = ListFilter {
                account_id: q.account_id,
                role_id: q.role_id,
                ids: None,
                include_ended: q.include_ended,
            };
            let all = store::list(tx, p.org_id, &filter, phase, OffsetDateTime::now_utc()).await?;
            if actor.may(Domain::Access, Level::View, &actor.tenant()) {
                return Ok(all);
            }
            // A scoped holder sees the grants over nodes it may view.
            let mut seen = Vec::with_capacity(all.len());
            for grant in all {
                let path = node_path(tx, p.org_id, grant.scope.kind, grant.scope.node_id).await;
                if path.is_ok_and(|path| actor.may(Domain::Access, Level::View, &path)) {
                    seen.push(grant);
                }
            }
            Ok(seen)
        })
    })
    .await?;
    Ok(grants)
}

/// Check every operation; a later operation that repeats an earlier grant or
/// touches the same grant again is refused.
pub(super) async fn check_all(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    phase: TenantPhase,
    now: OffsetDateTime,
    ops: &[Op],
) -> AccessResult<Vec<Checked>> {
    let mut out: Vec<Checked> = Vec::with_capacity(ops.len());
    let mut touched = BTreeSet::new();
    for (i, op) in ops.iter().enumerate() {
        let mut c = check(tx, actor, phase, now, i, op).await?;
        let repeat = match (op, &c.write) {
            (Op::Revoke { grant_id } | Op::SetEnd { grant_id, .. }, _) => {
                !touched.insert(*grant_id)
            }
            (Op::Grant { .. }, Some(row)) => out.iter().filter_map(|o| o.write.as_ref()).any(|o| {
                (o.account_id, o.role_id, o.kind, o.node_id)
                    == (row.account_id, row.role_id, row.kind, row.node_id)
                    && o.valid_to.is_none_or(|to| to > row.valid_from)
                    && row.valid_to.is_none_or(|to| to > o.valid_from)
            }),
            _ => false,
        };
        if repeat && !c.refused {
            c.refused = true;
            c.write = None;
            c.item["outcome"] = json!("REFUSED");
            c.item["refusal"] = json!({ "code": "duplicate_operation", "message": "the batch repeats this operation" });
            c.item["gains"] = json!([]);
            c.item["losses"] = json!([]);
        }
        out.push(c);
    }
    Ok(out)
}

/// Keys sorted at every level: the stored request comes back from JSONB in
/// its own key order.
fn sorted(v: &Value) -> Value {
    match v {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            Value::Object(
                keys.into_iter()
                    .map(|k| (k.clone(), sorted(&map[k])))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
        other => other.clone(),
    }
}

pub(super) fn digest(request: &Value, items: &[Value]) -> String {
    let canonical = sorted(&json!({ "request": request, "items": items })).to_string();
    hex::encode(Sha256::digest(canonical.as_bytes()))
}

pub async fn preview(s: &AccessService, p: Principal, body: Batch) -> AccessResult<Value> {
    if body.operations.is_empty() || body.operations.len() > MAX_BATCH {
        return Err(AccessError::invalid(
            "batch_too_large",
            "send 1 to 200 operations",
        ));
    }
    let now = OffsetDateTime::now_utc();
    let ops: Vec<Op> = body
        .operations
        .into_iter()
        .map(|o| Op::normalize(o, now))
        .collect();
    let receipt = Uuid::new_v4();
    let received = audit(
        &p,
        "access.grants.preview",
        "access_grant_receipts",
        receipt,
    )?
    .with_snapshots(None, Some(json!({"reason_code":body.reason_code})));
    let out = with_audit::<_, _, AccessError>(&s.pool, received, move |tx| {
        Box::pin(async move {
            let actor = Actor::load(tx, &p).await?;
            actor.require_some_access(Level::Edit)?;
            let org = actor.org();
            validate_reason(tx, org, &body.reason_code, body.reason_note.as_deref()).await?;
            let phase = load_tenant_phase(tx, org).await?;
            let checked = check_all(tx, &actor, phase, now, &ops).await?;
            let items: Vec<Value> = checked.iter().map(|c| c.item.clone()).collect();
            let refused = checked.iter().filter(|c| c.refused).count();
            let accounts: BTreeSet<String> = checked
                .iter()
                .filter(|c| !c.refused)
                .map(|c| c.item["account_id"].to_string())
                .collect();
            let request = json!({ "reason_code": body.reason_code, "reason_note": body.reason_note, "ops": ops });
            let digest = digest(&request, &items);
            let expires_at = now + RECEIPT_TTL;
            let receipt: Uuid = sqlx::query_scalar(
                "INSERT INTO access_grant_receipts (org_id, actor_id, digest, request, refused, expires_at, id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
            )
            .bind(org.as_uuid())
            .bind(actor.id())
            .bind(&digest)
            .bind(&request)
            .bind(i32::try_from(refused).unwrap_or(i32::MAX))
            .bind(expires_at)
            .bind(receipt)
            .fetch_one(tx.as_mut())
            .await?;
            let expires = expires_at
                .format(&time::format_description::well_known::Rfc3339)
                .map_err(AccessError::internal)?;
            Ok(json!({
                "receipt_id": receipt, "expires_at": expires, "digest": digest,
                "phase": phase.as_str(), "step_up_required": true, "items": items,
                "refused": refused, "accounts_affected": accounts.len(),
            }))
        })
    })
    .await?;
    Ok(out)
}

pub use apply::{ApplyOutcome, apply};
mod apply;
