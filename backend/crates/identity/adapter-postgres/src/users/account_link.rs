// SPDX-License-Identifier: LicenseRef-Proprietary
//! K1 ACCOUNT-LINK-GUARD: the frozen employee-binding request, its independent approval and notices.

use crate::policy::versions::bump_subject_version_tx;
use crate::users::rows::fetch_user_tx;
use crate::{PgOrgError, PgOrgStore};
use console_identity_application::{UpdateUserCommand, UserSummary, user_audit_event};
use console_kernel_core::KernelError;
use console_platform_db::with_audit;
use console_platform_request_context::current_org;
use sqlx::Row;

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
            let subject_is_self: bool = sqlx::query_scalar(
                "SELECT $2::uuid=$3::uuid OR EXISTS (SELECT 1 FROM users target JOIN users actor ON actor.org_id=target.org_id \
                 WHERE target.org_id=$1 AND target.id=$2 AND actor.id=$3 AND target.employee_id=actor.employee_id) \
                 OR EXISTS (SELECT 1 FROM public.console_decision_people($1,$2,$3) \
                 WHERE maker_person IS NOT NULL AND maker_person=checker_person)")
                .bind(org.as_uuid()).bind(target.as_uuid()).bind(actor.as_uuid()).fetch_one(tx.as_mut()).await.unwrap_or(true);
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
