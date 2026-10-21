use crate::policy::assignments::consume_policy_assignment_preview_receipt_tx;
use crate::policy::preview_receipt::{
    AssignmentPreviewReceiptConsumption, stale_policy_assignment_preview_error,
};
use crate::policy::rows::fetch_policy_role_assignments_tx;
use crate::policy::validate::{normalize_policy_role_ids, normalize_system_roles};
use crate::policy::versions::{bump_subject_version_tx, lock_policy_version_tx};
use crate::users::rows::{fetch_user_branch_uuid_ids_tx, fetch_user_tx};
use crate::users::scope::{replace_user_branches, resolve_actor_branch_scope_tx};
use crate::{PgOrgError, PgOrgStore};
use console_identity_application::{
    UpdateSelfProfileCommand, UpdateUserCommand, UserSummary, policy_account_audit_event,
    user_audit_event,
};
use console_identity_domain::{Team, normalize_optional_phone, validate_display_name};
use console_kernel_core::KernelError;
use console_platform_db::{insert_audit_event, with_audit};
use console_platform_request_context::current_org;
use sqlx::Row;

impl PgOrgStore {
    /// Partial update of a user's profile, roles, and/or memberships.
    pub async fn update_user(&self, command: UpdateUserCommand) -> Result<UserSummary, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let actor = command.actor;
        let user_id = command.user_id;
        let trace = command.trace.clone();
        let occurred_at = command.occurred_at;
        let preview_receipt_id = command.preview_receipt_id;
        let display_name = command
            .display_name
            .as_deref()
            .map(validate_display_name)
            .transpose()?;
        let employee_id = command.employee_id;
        let phone = match &command.phone {
            None => None,
            Some(value) => Some(normalize_optional_phone(value.as_deref())?),
        };
        let team_db: Option<Option<&'static str>> = command
            .team
            .as_ref()
            .map(|inner| inner.map(Team::as_db_str));
        let roles = command.roles.clone();
        let branch_ids: Option<Vec<uuid::Uuid>> = command
            .branch_ids
            .as_ref()
            .map(|ids| ids.iter().map(|b| *b.as_uuid()).collect());

        let event = user_audit_event(
            "user.update",
            Some(actor),
            user_id,
            trace.clone(),
            occurred_at,
        )?
        .with_org(org);

        with_audit::<_, UserSummary, PgOrgError>(&self.pool, event, |tx| {
            Box::pin(async move {
                // Ensure the target exists (and lock it) before mutating. Locking
                // the row also freezes the mutable authorization baseline checked
                // by the preview receipt below.
                let row = sqlx::query("SELECT roles FROM users WHERE id = $1 FOR UPDATE")
                    .bind(*user_id.as_uuid())
                    .fetch_optional(tx.as_mut())
                    .await?;
                let Some(row) = row else {
                    return Err(PgOrgError::Domain(KernelError::not_found("user not found")));
                };
                let before = fetch_user_tx(tx, user_id).await?;
                // Every caller, including non-HTTP callers, must use the approval transaction.
                if employee_id.is_some_and(|requested| requested != before.employee_id) {
                    return Err(KernelError::forbidden(
                        "직원 연결 변경은 패스키 확인과 다른 담당자의 승인이 필요합니다",
                    )
                    .with_code("account_link_approval_required")
                    .into());
                }
                let current_system_roles = normalize_system_roles(row.try_get("roles")?);
                let current_branch_ids = fetch_user_branch_uuid_ids_tx(tx, user_id).await?;
                let previous_assignments = fetch_policy_role_assignments_tx(tx, user_id).await?;
                let current_role_ids = normalize_policy_role_ids(
                    previous_assignments
                        .iter()
                        .map(|assignment| assignment.role_id)
                        .collect(),
                );

                // Delta-scope the receipt gate against the FOR UPDATE-locked row
                // (order-insensitive set-equality via normalize_*). Re-sending the
                // current roles/branches is a no-op and must not demand a receipt;
                // any real change — including one a concurrent writer made after the
                // client read — differs from the locked current set and still gates.
                let roles_changed = roles
                    .as_ref()
                    .is_some_and(|r| normalize_system_roles(r.clone()) != current_system_roles);
                let branches_changed = branch_ids.as_ref().is_some_and(|b| {
                    normalize_policy_role_ids(b.clone())
                        != normalize_policy_role_ids(current_branch_ids.clone())
                });
                let assignment_changed = roles_changed || branches_changed;

                if assignment_changed {
                    let preview_receipt_id =
                        preview_receipt_id.ok_or_else(stale_policy_assignment_preview_error)?;
                    let requested_system_roles = roles
                        .as_ref()
                        .map(|roles| normalize_system_roles(roles.clone()))
                        .unwrap_or_else(|| current_system_roles.clone());
                    let requested_branch_ids = branch_ids
                        .clone()
                        .map(normalize_policy_role_ids)
                        .unwrap_or_else(|| current_branch_ids.clone());
                    let policy_version = lock_policy_version_tx(tx, org_uuid).await?;
                    consume_policy_assignment_preview_receipt_tx(
                        tx,
                        AssignmentPreviewReceiptConsumption {
                            actor,
                            user_id,
                            current_branch_ids: &current_branch_ids,
                            current_system_roles: &current_system_roles,
                            current_role_ids: &current_role_ids,
                            branch_ids: &requested_branch_ids,
                            system_roles: &requested_system_roles,
                            role_ids: &current_role_ids,
                            policy_version,
                            receipt_id: preview_receipt_id,
                            occurred_at,
                            org_uuid,
                        },
                    )
                    .await?;
                }

                if let Some(display_name) = &display_name {
                    sqlx::query("UPDATE users SET display_name = $2 WHERE id = $1")
                        .bind(*user_id.as_uuid())
                        .bind(display_name)
                        .execute(tx.as_mut())
                        .await?;
                }
                if let Some(employee_id) = employee_id {
                    sqlx::query("UPDATE users SET employee_id = $2 WHERE id = $1")
                        .bind(*user_id.as_uuid())
                        .bind(employee_id)
                        .execute(tx.as_mut())
                        .await?;
                }
                if let Some(phone) = &phone {
                    sqlx::query("UPDATE users SET phone = $2 WHERE id = $1")
                        .bind(*user_id.as_uuid())
                        .bind(phone.as_deref())
                        .execute(tx.as_mut())
                        .await?;
                }
                if let Some(team_db) = team_db {
                    sqlx::query("UPDATE users SET team = $2 WHERE id = $1")
                        .bind(*user_id.as_uuid())
                        .bind(team_db)
                        .execute(tx.as_mut())
                        .await?;
                }
                if let Some(roles) = roles.as_ref().filter(|_| roles_changed) {
                    sqlx::query("UPDATE users SET roles = $2 WHERE id = $1")
                        .bind(*user_id.as_uuid())
                        .bind(roles)
                        .execute(tx.as_mut())
                        .await?;
                }
                if let Some(branch_ids) = branch_ids.as_ref().filter(|_| branches_changed) {
                    let actor_scope = resolve_actor_branch_scope_tx(tx, actor).await?;
                    replace_user_branches(tx, user_id, branch_ids, org_uuid, &actor_scope).await?;
                }
                if assignment_changed {
                    // System roles and branch memberships are authorization-relevant
                    // subject material; bump freshness once after a successful
                    // receipt-gated replacement (covers role AND/OR branch changes).
                    bump_subject_version_tx(tx, org_uuid, *user_id.as_uuid(), occurred_at).await?;
                }

                let after = fetch_user_tx(tx, user_id).await?;
                let policy_event = policy_account_audit_event(
                    "policy.account.update.snapshot",
                    Some(actor),
                    user_id,
                    trace,
                    occurred_at,
                )?
                .with_org(org)
                .with_snapshots(
                    Some(serde_json::json!({ "user": before })),
                    Some(serde_json::json!({ "user": &after })),
                );
                insert_audit_event(tx, &policy_event).await?;
                Ok(after)
            })
        })
        .await
    }

    /// Self-service profile edit (display name and/or phone only).
    pub async fn update_self_profile(
        &self,
        command: UpdateSelfProfileCommand,
    ) -> Result<UserSummary, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let display_name = command
            .display_name
            .as_deref()
            .map(validate_display_name)
            .transpose()?;
        let phone = match &command.phone {
            None => None,
            Some(value) => Some(normalize_optional_phone(value.as_deref())?),
        };
        let user_id = command.user_id;

        // Org-bind the audit row so it is tenant-attributable and the FORCE-RLS
        // `audit_events` write is armed via the same `with_audit` GUC.
        let event = user_audit_event(
            "user.update_self",
            Some(user_id),
            user_id,
            command.trace.clone(),
            command.occurred_at,
        )?
        .with_org(org);

        with_audit::<_, UserSummary, PgOrgError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let exists: Option<uuid::Uuid> =
                    sqlx::query_scalar("SELECT id FROM users WHERE id = $1 FOR UPDATE")
                        .bind(*user_id.as_uuid())
                        .fetch_optional(tx.as_mut())
                        .await?;
                if exists.is_none() {
                    return Err(PgOrgError::Domain(KernelError::not_found("user not found")));
                }
                if let Some(display_name) = &display_name {
                    sqlx::query("UPDATE users SET display_name = $2 WHERE id = $1")
                        .bind(*user_id.as_uuid())
                        .bind(display_name)
                        .execute(tx.as_mut())
                        .await?;
                }
                if let Some(phone) = &phone {
                    sqlx::query("UPDATE users SET phone = $2 WHERE id = $1")
                        .bind(*user_id.as_uuid())
                        .bind(phone.as_deref())
                        .execute(tx.as_mut())
                        .await?;
                }
                fetch_user_tx(tx, user_id).await
            })
        })
        .await
    }
}

#[derive(Debug, serde::Serialize)]
pub struct AccountLinkProposal {
    pub request_id: uuid::Uuid,
    pub status: &'static str,
    pub requested_by: console_kernel_core::UserId,
    pub requester_name: String,
    pub user_id: console_kernel_core::UserId,
    pub employee_id: Option<uuid::Uuid>,
}

#[derive(Debug, serde::Serialize)]
pub struct AccountLinkOutcome {
    #[serde(flatten)]
    pub user: UserSummary,
    pub account_link: Option<AccountLinkProposal>,
}

impl PgOrgStore {
    /// Request or explicitly approve a frozen employee binding. The caller verifies passkey step-up.
    /// Identity, eligibility, baseline, application, audit and notices share this transaction.
    pub async fn change_account_link(
        &self,
        command: UpdateUserCommand,
        request_id: Option<uuid::Uuid>,
    ) -> Result<AccountLinkOutcome, PgOrgError> {
        use crate::second_person::{SecondPersonQuery, second_person_fact_in_tx};
        use console_kernel_core::UserId;
        use console_platform_authz::Feature;
        use console_platform_authz::cedar_pbac::actions::{account_link, independent_people};
        use console_platform_db::with_audits;
        use console_settings_adapter_postgres::resolve_in_tx;
        use console_settings_domain::{SettingKey, SettingValue};

        let org = current_org().map_err(KernelError::from)?;
        let desired = command
            .employee_id
            .ok_or_else(|| KernelError::validation("employee_id is required"))?;
        let actor = command.actor;
        let target = command.user_id;
        let now = command.occurred_at;
        with_audits::<_, _, PgOrgError>(&self.pool, org, move |tx| Box::pin(async move {
            // Serialize proposals per account before reading their requester or locking identity rows.
            sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))")
                .bind(org.to_string()).bind(target.to_string()).execute(tx.as_mut()).await?;
            let proposal = match request_id {
                Some(id) => sqlx::query("SELECT * FROM account_link_requests WHERE org_id = $1 AND user_id = $2 AND id = $3 FOR UPDATE")
                    .bind(org.as_uuid()).bind(target.as_uuid()).bind(id).fetch_optional(tx.as_mut()).await?,
                None => sqlx::query("SELECT * FROM account_link_requests WHERE org_id = $1 AND user_id = $2 AND status = 'PENDING' FOR UPDATE")
                    .bind(org.as_uuid()).bind(target.as_uuid()).fetch_optional(tx.as_mut()).await?,
            };
            let requester: UserId = proposal.as_ref().map(|row| row.try_get::<uuid::Uuid, _>("requested_by"))
                .transpose()?.map(UserId::from_uuid).unwrap_or(actor);
            sqlx::query("SELECT id FROM users WHERE org_id = $1 AND id = ANY($2) ORDER BY id FOR UPDATE")
                .bind(org.as_uuid()).bind(vec![*actor.as_uuid(), *target.as_uuid(), *requester.as_uuid()])
                .fetch_all(tx.as_mut()).await?;
            let before = fetch_user_tx(tx, target).await?;
            let subject_is_self = !independent_people::authorized_in_tx(tx, Some(*target.as_uuid()), *actor.as_uuid()).await?;
            let mut facts = account_link::LinkFacts { subject_is_self, approving: false, independent: false, eligible: false };
            if !account_link::decide(&actor.to_string(), &org.to_string(), &org.to_string(), facts) {
                return Err(KernelError::forbidden("본인 계정의 직원 연결은 변경할 수 없습니다. 다른 담당자에게 요청하십시오")
                    .with_code("account_link_self_forbidden").into());
            }
            if request_id.is_none() && before.employee_id == desired {
                return Ok((AccountLinkOutcome { user: before, account_link: None }, vec![]));
            }
            if let Some(employee) = desired {
                let exists: Option<uuid::Uuid> = sqlx::query_scalar("SELECT id FROM employees WHERE org_id = $1 AND id = $2 FOR SHARE")
                    .bind(org.as_uuid()).bind(employee).fetch_optional(tx.as_mut()).await?;
                if exists.is_none() { return Err(KernelError::validation("직원 기록을 찾을 수 없습니다").into()); }
            }
            let key = SettingKey::AuthzSecondPersonMinGrantAge;
            let settings = resolve_in_tx(tx.as_mut(), org, &[key], None, now).await?;
            let age = match settings.get(&key) {
                Some(Ok(resolved)) => match resolved.value {
                    SettingValue::Int(days) => i32::try_from(days).map_err(|_| KernelError::internal("second-person grant age is out of range"))?,
                    _ => return Err(KernelError::internal("second-person grant age is not an integer").into()),
                },
                _ => return Err(KernelError::internal("second-person grant age did not resolve").into()),
            };
            let case_created_at = proposal.as_ref().map(|row| row.try_get("created_at")).transpose()?.unwrap_or(now);
            let second = second_person_fact_in_tx(tx, &SecondPersonQuery {
                org, feature: Feature::UserManage, branch: None, requester, excluded: vec![target],
                case_created_at, min_grant_age_days: age,
            }).await?;
            let (id, requested_by, status, action) = if let Some(id) = request_id {
                let row = proposal.ok_or_else(account_link_stale)?;
                let previous: Option<uuid::Uuid> = row.try_get("previous_employee_id")?;
                let proposed: Option<uuid::Uuid> = row.try_get("employee_id")?;
                let state: String = row.try_get("status")?;
                if proposed != desired || state != "PENDING" || previous != before.employee_id {
                    return Err(account_link_stale().into());
                }
                facts.approving = true;
                facts.independent = independent_people::authorized_in_tx(tx, Some(*requester.as_uuid()), *actor.as_uuid()).await?;
                facts.eligible = second.eligible.contains(actor.as_uuid());
                if !account_link::decide(&actor.to_string(), &org.to_string(), &org.to_string(), facts) {
                    return Err(KernelError::forbidden("요청자와 다른 확인 권한자가 승인해야 합니다")
                        .with_code("account_link_second_person_required").into());
                }
                sqlx::query("UPDATE account_link_requests SET status = 'APPROVED', approved_by = $2, approved_at = $3 WHERE id = $1")
                    .bind(id).bind(actor.as_uuid()).bind(now).execute(tx.as_mut()).await?;
                sqlx::query("UPDATE users SET employee_id = $2 WHERE id = $1")
                    .bind(target.as_uuid()).bind(desired).execute(tx.as_mut()).await?;
                bump_subject_version_tx(tx, *org.as_uuid(), *target.as_uuid(), now).await?;
                (id, requester, "APPROVED", "account_link.approved")
            } else {
                if let Some(row) = proposal {
                    let previous: Option<uuid::Uuid> = row.try_get("previous_employee_id")?;
                    let proposed: Option<uuid::Uuid> = row.try_get("employee_id")?;
                    let id: uuid::Uuid = row.try_get("id")?;
                    if previous == before.employee_id && proposed == desired {
                        return Ok((AccountLinkOutcome { user: before, account_link: Some(AccountLinkProposal {
                            request_id: id, status: "PENDING", requested_by: requester,
                            requester_name: fetch_user_tx(tx, requester).await?.display_name, user_id: target, employee_id: desired,
                        }) }, vec![]));
                    }
                    sqlx::query("UPDATE account_link_requests SET status = 'SUPERSEDED' WHERE id = $1")
                        .bind(id).execute(tx.as_mut()).await?;
                }
                let id: uuid::Uuid = sqlx::query_scalar("INSERT INTO account_link_requests (org_id, user_id, previous_employee_id, employee_id, requested_by, created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id")
                    .bind(org.as_uuid()).bind(target.as_uuid()).bind(before.employee_id).bind(desired).bind(actor.as_uuid()).bind(now)
                    .fetch_one(tx.as_mut()).await?;
                (id, actor, "PENDING", "account_link.requested")
            };
            let proposal = AccountLinkProposal { request_id: id, status, requested_by,
                requester_name: fetch_user_tx(tx, requested_by).await?.display_name, user_id: target, employee_id: desired };
            let event = user_audit_event(action, Some(actor), target, command.trace, now)?.with_org(org)
                .with_snapshots(Some(serde_json::json!({ "employee_id": before.employee_id })), Some(serde_json::json!(&proposal)));
            let message = if status == "PENDING" {
                format!("{} 계정의 직원 연결 변경을 요청했습니다. 다른 담당자가 직원 기록에서 같은 계정을 선택해 확인하기 전까지 현재 연결을 유지합니다", before.display_name)
            } else { format!("다른 담당자가 {} 계정의 직원 연결 변경을 승인했습니다", before.display_name) };
            account_link_notice(tx, org, target, id, status, &message, desired.or(before.employee_id)).await?;
            if status == "PENDING" {
                for eligible in second.eligible {
                    let eligible = UserId::from_uuid(eligible);
                    if independent_people::authorized_in_tx(tx, Some(*actor.as_uuid()), *eligible.as_uuid()).await? {
                        account_link_notice(tx, org, eligible, id, status, &message, desired.or(before.employee_id)).await?;
                    }
                }
            }
            Ok((AccountLinkOutcome { user: fetch_user_tx(tx, target).await?, account_link: Some(proposal) }, vec![event]))
        })).await
    }

    /// Refusals commit independently of the rolled-back binding mutation.
    pub async fn record_account_link_refusal(
        &self,
        actor: console_kernel_core::UserId,
        target: console_kernel_core::UserId,
        trace: console_kernel_core::TraceContext,
        code: &'static str,
    ) -> Result<(), PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let event = user_audit_event(
            "account_link.refused",
            Some(actor),
            target,
            trace.clone(),
            time::OffsetDateTime::now_utc(),
        )?
        .with_org(org)
        .with_snapshots(
            None,
            Some(serde_json::json!({ "code": code, "reference": trace.trace_id() })),
        );
        let notice_id = *event.id.as_uuid();
        with_audit::<_, (), PgOrgError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let employee = sqlx::query_scalar("SELECT employee_id FROM users WHERE id = $1")
                    .bind(target.as_uuid())
                    .fetch_one(tx.as_mut())
                    .await?;
                account_link_notice(
                    tx,
                    org,
                    target,
                    notice_id,
                    "REFUSED",
                    "계정의 직원 연결 변경을 거부했습니다. 현재 연결을 유지합니다",
                    employee,
                )
                .await
            })
        })
        .await
    }
}

fn account_link_stale() -> KernelError {
    KernelError::conflict("직원 연결 요청의 내용이나 현재 연결이 바뀌었습니다. 다시 요청하십시오")
        .with_code("account_link_stale")
}

async fn account_link_notice(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: console_kernel_core::OrgId,
    recipient: console_kernel_core::UserId,
    request: uuid::Uuid,
    status: &str,
    message: &str,
    employee: Option<uuid::Uuid>,
) -> Result<(), PgOrgError> {
    let link = employee.map_or_else(
        || serde_json::json!({ "screen": "account" }),
        |id| serde_json::json!({ "kind": "employee", "id": id }),
    );
    sqlx::query("INSERT INTO notifications (org_id, recipient_user_id, category, body, link, dedup_key) VALUES ($1,$2,'account_link',$3,$4,$5) ON CONFLICT (org_id, recipient_user_id, dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING")
        .bind(org.as_uuid()).bind(recipient.as_uuid()).bind(message).bind(link).bind(format!("account_link:{request}:{status}"))
        .execute(tx.as_mut()).await?;
    Ok(())
}
