//! One grant operation, checked: the same function runs at preview and again
//! inside the apply transaction, so apply refuses anything that changed.

use console_kernel_core::TenantPhase;
use console_platform_authz::access::{Enforcement, GrantState, Level, NodeKind, NodePath};
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::actor::{Actor, node_path, refuse_closed};
use crate::dto::{LineOut, parse_scope};
use crate::error::{AccessError, AccessResult};
use crate::grant_types::Op;
use crate::grants_store::{self as store, GrantRow};
use crate::roles_store::lines_of;

/// The checked outcome of one operation.
pub(crate) struct Checked {
    pub item: Value,
    pub refused: bool,
    /// The new grant apply inserts (grant operations only).
    pub write: Option<GrantRow>,
}

fn refused(code: &'static str, message: &str) -> AccessError {
    AccessError::invalid(code, message)
}

fn effects(lines: &[LineOut], scope: &Value) -> Vec<Value> {
    lines
        .iter()
        .flat_map(|l| {
            l.levels
                .iter()
                .map(move |lv| json!({ "domain": l.domain, "level": lv, "scope": scope }))
        })
        .collect()
}

fn scope_json(kind: NodeKind, node: Option<Uuid>) -> Value {
    json!({ "kind": kind, "node_id": node, "include_descendants": true })
}

/// Check one operation; a refusal becomes a REFUSED item, a store failure an error.
pub(crate) async fn check(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    phase: TenantPhase,
    now: OffsetDateTime,
    index: usize,
    op: &Op,
) -> AccessResult<Checked> {
    let (name, account, grant) = match op {
        Op::Grant {
            account_id,
            grant_id,
            ..
        } => ("grant", *account_id, Some(*grant_id)),
        Op::Revoke { grant_id } => ("revoke", Uuid::nil(), Some(*grant_id)),
        Op::SetEnd { grant_id, .. } => ("set_end", Uuid::nil(), Some(*grant_id)),
    };
    match check_inner(tx, actor, phase, now, op).await {
        Ok(ok) => Ok(ok),
        Err(e) if !e.is_refusal() => Err(e),
        Err(e) => Ok(Checked {
            item: json!({
                "index": index, "op": name, "outcome": "REFUSED",
                "refusal": { "code": e.code, "message": e.message },
                "account_id": account, "grant_id": grant,
                "enforcement_after": Value::Null, "gains": [], "losses": [],
            }),
            refused: true,
            write: None,
        }),
    }
    .map(|mut c| {
        if !c.refused {
            c.item["index"] = json!(index);
            c.item["op"] = json!(name);
            c.item["outcome"] = json!("OK");
            c.item["refusal"] = Value::Null;
        }
        c
    })
}

async fn role_lines(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    role: Uuid,
) -> AccessResult<Vec<LineOut>> {
    let (status, version) = store::role_head(tx, actor.org(), role)
        .await?
        .ok_or_else(|| AccessError::not_found("role_not_found", "no such role"))?;
    if status != "ACTIVE" {
        return Err(AccessError::conflict(
            "role_not_active",
            "only an ACTIVE role is granted",
        ));
    }
    lines_of(tx, actor.org(), role, version).await
}

fn require_scope_edit(actor: &Actor, at: &NodePath) -> AccessResult<()> {
    if actor.may(
        console_platform_authz::access::Domain::Access,
        Level::Edit,
        at,
    ) {
        Ok(())
    } else {
        Err(AccessError::access_denied())
    }
}

async fn check_inner(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Actor,
    phase: TenantPhase,
    now: OffsetDateTime,
    op: &Op,
) -> AccessResult<Checked> {
    let org = actor.org();
    match op {
        Op::Grant {
            grant_id,
            account_id,
            role_id,
            scope,
            valid_from,
            valid_to,
            effective_in_setup,
        } => {
            let (kind, node) = parse_scope(scope)?;
            let (active, is_ops) = store::account(tx, org, *account_id)
                .await?
                .ok_or_else(|| AccessError::not_found("account_not_found", "no such account"))?;
            if !active {
                return Err(refused("account_inactive", "the account is deactivated"));
            }
            if is_ops {
                return Err(AccessError::conflict(
                    "grant_target_is_ops",
                    "the ops account already holds everything",
                ));
            }
            if *account_id == actor.id() {
                return Err(AccessError::forbidden(
                    "self_grant_forbidden",
                    "nobody grants to themself",
                ));
            }
            if valid_to.is_some_and(|to| to <= *valid_from || to <= now) {
                return Err(refused(
                    "valid_range_invalid",
                    "valid_to must be after valid_from and now",
                ));
            }
            let lines = role_lines(tx, actor, *role_id).await?;
            let path = node_path(tx, org, kind, node).await?;
            refuse_closed(tx, org, &path).await?;
            require_scope_edit(actor, &path)?;
            actor.require_holds(&lines, &path)?;
            let row = GrantRow {
                id: *grant_id,
                account_id: *account_id,
                role_id: *role_id,
                kind,
                node_id: node,
                valid_from: *valid_from,
                valid_to: *valid_to,
                revoked: false,
                effective_in_setup: *effective_in_setup,
            };
            if store::overlaps(tx, org, &row).await? {
                return Err(AccessError::conflict(
                    "grant_overlap",
                    "the account already holds this role over this scope then",
                ));
            }
            let state = GrantState {
                revoked: false,
                role_active: true,
                valid_from: *valid_from,
                valid_to: *valid_to,
                effective_in_setup: *effective_in_setup,
            };
            let after = state.enforcement(phase, now);
            let gains = if after == Enforcement::Enforced {
                effects(&lines, &scope_json(kind, node))
            } else {
                vec![]
            };
            Ok(Checked {
                item: json!({ "account_id": account_id, "grant_id": grant_id, "enforcement_after": after, "gains": gains, "losses": [] }),
                refused: false,
                write: Some(row),
            })
        }
        Op::Revoke { grant_id } | Op::SetEnd { grant_id, .. } => {
            let row = store::grant_row(tx, org, *grant_id, true)
                .await?
                .ok_or_else(|| AccessError::not_found("grant_not_found", "no such grant"))?;
            if row.revoked || row.valid_to.is_some_and(|to| to <= now) {
                return Err(AccessError::conflict(
                    "grant_ended",
                    "the grant is already revoked or ended",
                ));
            }
            let path = node_path(tx, org, row.kind, row.node_id).await?;
            require_scope_edit(actor, &path)?;
            let (_, version) = store::role_head(tx, org, row.role_id)
                .await?
                .unwrap_or_default();
            let lines = lines_of(tx, org, row.role_id, version).await?;
            let scope = scope_json(row.kind, row.node_id);
            let (after, gains, losses) = if let Op::SetEnd { valid_to, .. } = op {
                let state = |to| GrantState {
                    revoked: false,
                    role_active: true,
                    valid_from: row.valid_from,
                    valid_to: to,
                    effective_in_setup: row.effective_in_setup,
                };
                if valid_to.is_some_and(|to| to <= row.valid_from || to <= now) {
                    return Err(refused(
                        "valid_range_invalid",
                        "the new end must be after the start and now; revoke instead",
                    ));
                }
                let longer = match (row.valid_to, valid_to) {
                    (Some(_), None) => true,
                    (Some(old), Some(new)) => *new > old,
                    (None, _) => false,
                };
                if longer {
                    if row.account_id == actor.id() {
                        return Err(AccessError::forbidden(
                            "self_grant_forbidden",
                            "nobody extends their own grant",
                        ));
                    }
                    actor.require_holds(&lines, &path)?;
                }
                let before = state(row.valid_to).enforcement(phase, now);
                let after = state(*valid_to).enforcement(phase, now);
                (
                    after,
                    Vec::<Value>::new(),
                    if before == Enforcement::Enforced && after != Enforcement::Enforced {
                        effects(&lines, &scope)
                    } else {
                        vec![]
                    },
                )
            } else {
                let held = GrantState {
                    revoked: false,
                    role_active: true,
                    valid_from: row.valid_from,
                    valid_to: row.valid_to,
                    effective_in_setup: row.effective_in_setup,
                };
                let losses = if held.enforcement(phase, now) == Enforcement::Enforced {
                    effects(&lines, &scope)
                } else {
                    vec![]
                };
                (Enforcement::Revoked, vec![], losses)
            };
            Ok(Checked {
                item: json!({ "account_id": row.account_id, "grant_id": grant_id, "enforcement_after": after, "gains": gains, "losses": losses }),
                refused: false,
                write: None,
            })
        }
    }
}
