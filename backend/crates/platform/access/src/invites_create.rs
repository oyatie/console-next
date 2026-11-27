// SPDX-License-Identifier: LicenseRef-Proprietary
//! Atomic write path for `POST /api/v1/access/invites`: user creation,
//! initial role/scope grants, and single-use sign-in OTP in one transaction.

use console_identity_adapter_postgres::users::create::create_user_in_tx;
use console_identity_application::CreateUserCommand;
use console_kernel_core::{TenantPhase, TraceContext};
use console_platform_authz::Principal;
use console_platform_authz::access::{Level, load_tenant_phase};
use console_platform_db::{DbError, idempotency, with_audits};
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::AccessService;
use crate::actor::{Actor, audit, validate_reason, verify_step_up};
use crate::error::{AccessError, AccessResult};
use crate::grant_types::{Op, OpIn};
use crate::grants::check_all;
use crate::grants_store::{self as store, ListFilter, NewGrant};
use crate::invites::{
    CreateInviteIn, INVITE_OTP_TTL_HOURS, MAX_INVITE_GRANTS, require_invite_authority,
    validate_invite_target_tx,
};
use crate::ops_holders::map_org_err;

pub async fn create(
    s: &AccessService,
    p: Principal,
    idempotency_key: String,
    mut body: CreateInviteIn,
) -> AccessResult<(bool, Value)> {
    if body.grants.len() > MAX_INVITE_GRANTS {
        return Err(AccessError::invalid(
            "batch_too_large",
            "send at most 20 initial grants per invite",
        ));
    }
    let idempotency_key = idempotency::validate_idempotency_key(Some(idempotency_key.as_str()))
        .map_err(|msg| AccessError::invalid("idempotency_key_invalid", msg))?;
    let fingerprint = serde_json::to_value(&body).map_err(AccessError::internal)?;
    let step_up = body.step_up.take();
    verify_step_up(s, &p, step_up).await?;

    let now = OffsetDateTime::now_utc();
    let bootstrap = s.bootstrap.clone();
    let operation_id = console_platform_db::command_context::current()
        .and_then(|c| c.command_id)
        .unwrap_or_else(Uuid::new_v4);

    with_audits::<_, _, AccessError>(&s.pool, p.org_id, move |tx| {
        Box::pin(async move {
            const OP_KEY: &str = "access.invites.create";
            match idempotency::claim_idempotency_key(tx, OP_KEY, &idempotency_key, &fingerprint)
                .await
                .map_err(DbError::from)?
            {
                idempotency::IdempotencyClaim::Replay(cached) => {
                    return Ok(((false, cached), Vec::new()));
                }
                idempotency::IdempotencyClaim::Mismatch => {
                    return Err(AccessError::conflict(
                        idempotency::IDEMPOTENCY_KEY_REUSED,
                        "idempotency key was already used with a different request",
                    ));
                }
                idempotency::IdempotencyClaim::Fresh => {}
            }

            let actor = Actor::load(tx, &p).await?;
            require_invite_authority(&p, &actor)?;
            let org = actor.org();
            sqlx::query("SELECT set_config('app.current_actor', $1, true)")
                .bind(actor.id().to_string())
                .execute(tx.as_mut())
                .await?;

            let parsed_login = validate_invite_target_tx(
                tx,
                *org.as_uuid(),
                &body.display_name,
                body.phone.as_deref(),
                body.sign_in_id.as_deref(),
                body.employee_id,
            )
            .await?;

            let cmd = CreateUserCommand {
                actor: p.user_id,
                display_name: body.display_name.clone(),
                employee_id: body.employee_id,
                phone: body.phone.clone(),
                team: None,
                roles: Vec::new(),
                branch_ids: Vec::new(),
                sign_in_id: parsed_login,
                trace: TraceContext::generate(),
                occurred_at: now,
            };
            let (summary, user_event) = create_user_in_tx(tx, org, &cmd)
                .await
                .map_err(map_org_err)?;
            let target_uuid = *summary.id.as_uuid();
            let mut events = vec![user_event];
            let phase = load_tenant_phase(tx, org).await?;

            let applied_grants = if body.grants.is_empty() {
                Vec::new()
            } else {
                actor.require_some_access(Level::Edit)?;
                let reason = body.reason_code.as_deref().unwrap_or_default();
                validate_reason(tx, org, reason, body.reason_note.as_deref()).await?;
                let ops: Vec<Op> = body
                    .grants
                    .iter()
                    .cloned()
                    .map(|g| {
                        Op::normalize(
                            OpIn::Grant {
                                account_id: target_uuid,
                                role_id: g.role_id,
                                scope: g.scope,
                                valid_from: g.valid_from,
                                valid_to: g.valid_to,
                                effective_in_setup: g.effective_in_setup,
                            },
                            now,
                        )
                    })
                    .collect();
                let checked = check_all(tx, &actor, phase, now, &ops).await?;
                if checked.iter().any(|c| c.refused) {
                    let items: Vec<Value> = checked.into_iter().map(|c| c.item).collect();
                    let mut err = AccessError::conflict(
                        "invite_grants_refused",
                        "one or more initial grants were refused; nothing was created",
                    );
                    err.details = Some(Box::new(json!({ "items": items })));
                    return Err(err);
                }
                let mode = if phase == TenantPhase::Setup {
                    "SETUP"
                } else {
                    "OPERATING"
                };
                let mut grant_ids = Vec::with_capacity(ops.len());
                for (op, c) in ops.iter().zip(&checked) {
                    if let Op::Grant { grant_id, .. } = op {
                        let row = c
                            .write
                            .as_ref()
                            .ok_or_else(|| AccessError::internal("grant without its row"))?;
                        let new = NewGrant {
                            row,
                            change_mode: mode,
                            reason_code: reason,
                            reason_note: body.reason_note.as_deref(),
                            granted_by: actor.id(),
                        };
                        store::insert_with_deadline(tx, org, &new, c.activates_at).await?;
                        grant_ids.push(*grant_id);
                    }
                }
                let grant_audit = audit(&p, "access.invites.grant", "users", target_uuid)?
                    .with_snapshots(
                        None,
                        Some(json!({ "reason_code": reason, "grant_count": grant_ids.len() })),
                    );
                events.push(grant_audit);
                store::list(
                    tx,
                    org,
                    &ListFilter {
                        ids: Some(grant_ids),
                        include_ended: true,
                        ..ListFilter::default()
                    },
                    phase,
                    now,
                )
                .await?
            };

            let (otp_issue, otp_events) = bootstrap
                .issue_for_zero_credential_user_tx(
                    tx,
                    Some(p.user_id),
                    target_uuid,
                    org,
                    now,
                    Duration::hours(INVITE_OTP_TTL_HOURS),
                )
                .await
                .map_err(AccessError::internal)?;
            events.extend(otp_events);

            let expires_str = console_kernel_core::rfc3339(otp_issue.expires_at)?;
            let stored_receipt = json!({
                "user": summary,
                "grants": applied_grants,
                "otp": Value::Null,
                "otp_expires_at": expires_str,
                "operation_id": operation_id,
            });
            idempotency::complete_idempotency_key(tx, OP_KEY, &idempotency_key, &stored_receipt)
                .await
                .map_err(DbError::from)?;

            let mut live_response = stored_receipt;
            live_response["otp"] = json!(otp_issue.token.as_str());
            Ok(((true, live_response), events))
        })
    })
    .await
}
