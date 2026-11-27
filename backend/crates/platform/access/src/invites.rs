// SPDX-License-Identifier: LicenseRef-Proprietary
//! Combined atomic account invite + initial role/scope grants + first sign-in
//! OTP under a single passkey step-up assertion (`POST /api/v1/access/invites`).

#[path = "invites_create.rs"]
mod create_impl;

use console_identity_adapter_postgres::sign_in_id::parse_login;
use console_identity_domain::{normalize_optional_phone, validate_display_name};
use console_platform_authz::Principal;
use console_platform_authz::access::{Domain, Enforcement, GrantState, Level, load_tenant_phase};
use console_platform_db::with_org_conn;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::AccessService;
use crate::actor::{Actor, node_path, refuse_closed, validate_reason};
use crate::dto::{ScopeIn, StepUp, parse_scope};
use crate::error::{AccessError, AccessResult};
use crate::grants_store as store;
use crate::ops_holders::map_org_err;
use crate::roles_store::lines_of;

pub use create_impl::create;

pub(crate) const INVITE_OTP_TTL_HOURS: i64 = 24;
pub(crate) const MAX_INVITE_GRANTS: usize = 20;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InviteGrantLineIn {
    pub role_id: Uuid,
    pub scope: ScopeIn,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub valid_from: Option<OffsetDateTime>,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub valid_to: Option<OffsetDateTime>,
    #[serde(default)]
    pub effective_in_setup: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreviewInviteIn {
    pub display_name: String,
    #[serde(default)]
    pub employee_id: Option<Uuid>,
    #[serde(default)]
    pub phone: Option<String>,
    #[serde(default)]
    pub sign_in_id: Option<String>,
    #[serde(default)]
    pub grants: Vec<InviteGrantLineIn>,
    #[serde(default)]
    pub reason_code: Option<String>,
    #[serde(default)]
    pub reason_note: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CreateInviteIn {
    pub display_name: String,
    #[serde(default)]
    pub employee_id: Option<Uuid>,
    #[serde(default)]
    pub phone: Option<String>,
    #[serde(default)]
    pub sign_in_id: Option<String>,
    #[serde(default)]
    pub grants: Vec<InviteGrantLineIn>,
    #[serde(default)]
    pub reason_code: Option<String>,
    #[serde(default)]
    pub reason_note: Option<String>,
    #[serde(default, skip_serializing)]
    pub step_up: Option<StepUp>,
}

pub(crate) fn require_invite_authority(p: &Principal, actor: &Actor) -> AccessResult<()> {
    let can_manage_users =
        p.is_tenant_ops || actor.may(Domain::Access, Level::Edit, &actor.tenant());
    if can_manage_users {
        Ok(())
    } else {
        Err(AccessError::forbidden(
            "user_manage_required",
            "account invite permission is required",
        ))
    }
}

pub(crate) async fn validate_invite_target_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    display_name: &str,
    phone: Option<&str>,
    sign_in_id: Option<&str>,
    employee_id: Option<Uuid>,
) -> AccessResult<Option<String>> {
    validate_display_name(display_name)?;
    normalize_optional_phone(phone)?;
    let parsed_login = sign_in_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(parse_login)
        .transpose()
        .map_err(map_org_err)?;
    if let Some(ref login) = parsed_login {
        let taken: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM user_sign_in_ids WHERE org_id = $1 AND login = $2)",
        )
        .bind(org)
        .bind(login)
        .fetch_one(tx.as_mut())
        .await?;
        if taken {
            return Err(AccessError::conflict(
                "sign_in_id_taken",
                "that sign-in ID is already used or reserved",
            ));
        }
    }
    if let Some(emp_id) = employee_id {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM employees WHERE org_id = $1 AND id = $2)",
        )
        .bind(org)
        .bind(emp_id)
        .fetch_one(tx.as_mut())
        .await?;
        if !exists {
            return Err(AccessError::not_found(
                "employee_not_found",
                "employee not found in this organization",
            ));
        }
        let linked: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM users WHERE org_id = $1 AND employee_id = $2 LIMIT 1",
        )
        .bind(org)
        .bind(emp_id)
        .fetch_optional(tx.as_mut())
        .await?;
        if let Some(existing_user) = linked {
            let mut err = AccessError::conflict(
                "employee_already_linked",
                "this employee already has a linked account",
            );
            err.details = Some(Box::new(json!({ "existing_user_id": existing_user })));
            return Err(err);
        }
    }
    Ok(parsed_login)
}

pub async fn preview(
    s: &AccessService,
    p: Principal,
    body: PreviewInviteIn,
) -> AccessResult<Value> {
    if body.grants.len() > MAX_INVITE_GRANTS {
        return Err(AccessError::invalid(
            "batch_too_large",
            "send at most 20 initial grants per invite",
        ));
    }
    let now = OffsetDateTime::now_utc();
    with_org_conn::<_, _, AccessError>(&s.pool, p.org_id, move |tx| {
        Box::pin(async move {
            let actor = Actor::load(tx, &p).await?;
            require_invite_authority(&p, &actor)?;
            let org = actor.org();
            validate_invite_target_tx(
                tx,
                *org.as_uuid(),
                &body.display_name,
                body.phone.as_deref(),
                body.sign_in_id.as_deref(),
                body.employee_id,
            )
            .await?;
            let phase = load_tenant_phase(tx, org).await?;
            if body.grants.is_empty() {
                return Ok(json!({
                    "phase": phase.as_str(),
                    "step_up_required": true,
                    "refused": 0,
                    "items": [],
                }));
            }
            actor.require_some_access(Level::Edit)?;
            let reason = body.reason_code.as_deref().unwrap_or_default();
            validate_reason(tx, org, reason, body.reason_note.as_deref()).await?;
            let deadline =
                crate::pending::sole_admin_deadline(tx, org, &console_kernel_core::FixedClock(now))
                    .await?;
            let mut items = Vec::with_capacity(body.grants.len());
            let mut refused = 0_usize;
            let mut seen_scopes = Vec::new();
            for (idx, line) in body.grants.iter().enumerate() {
                let from = line.valid_from.unwrap_or(now);
                let check_res: AccessResult<(Enforcement, Option<OffsetDateTime>)> = async {
                    let (kind, node) = parse_scope(&line.scope)?;
                    if line.valid_to.is_some_and(|to| to <= from || to <= now) {
                        return Err(AccessError::invalid(
                            "valid_range_invalid",
                            "valid_to must be after valid_from and now",
                        ));
                    }
                    let (status, version) = store::role_head(tx, org, line.role_id)
                        .await?
                        .ok_or_else(|| AccessError::not_found("role_not_found", "no such role"))?;
                    if status != "ACTIVE" {
                        return Err(AccessError::conflict(
                            "role_not_active",
                            "role is not active",
                        ));
                    }
                    let role_lines = lines_of(tx, org, line.role_id, version).await?;
                    let path = node_path(tx, org, kind, node).await?;
                    refuse_closed(tx, org, &path).await?;
                    if !actor.may(Domain::Access, Level::Edit, &path) {
                        return Err(AccessError::access_denied());
                    }
                    actor.require_holds(&role_lines, &path)?;
                    if seen_scopes.contains(&(line.role_id, kind, node)) {
                        return Err(AccessError::invalid(
                            "duplicate_operation",
                            "duplicate grant line in invite",
                        ));
                    }
                    seen_scopes.push((line.role_id, kind, node));
                    let activates_at = deadline.filter(|_| {
                        role_lines
                            .iter()
                            .any(|l| l.levels.iter().any(|lv| *lv != Level::View))
                    });
                    let state = GrantState {
                        revoked: false,
                        role_active: true,
                        valid_from: from,
                        valid_to: line.valid_to,
                        effective_in_setup: line.effective_in_setup,
                    };
                    let after = if activates_at.is_some() {
                        Enforcement::Scheduled
                    } else {
                        state.enforcement(phase, now)
                    };
                    Ok((after, activates_at))
                }
                .await;
                match check_res {
                    Ok((after, activates_at)) => {
                        let mut item = json!({
                            "index": idx,
                            "op": "grant",
                            "outcome": "OK",
                            "refusal": Value::Null,
                            "enforcement_after": after,
                        });
                        if let Some(at) = activates_at {
                            item["activates_at"] = json!(console_kernel_core::rfc3339(at)?);
                        }
                        items.push(item);
                    }
                    Err(e) if e.is_refusal() => {
                        refused += 1;
                        items.push(json!({
                            "index": idx,
                            "op": "grant",
                            "outcome": "REFUSED",
                            "refusal": { "code": e.code, "message": e.message },
                            "enforcement_after": Value::Null,
                        }));
                    }
                    Err(e) => return Err(e),
                }
            }
            Ok(json!({
                "phase": phase.as_str(),
                "step_up_required": true,
                "refused": refused,
                "items": items,
            }))
        })
    })
    .await
}
