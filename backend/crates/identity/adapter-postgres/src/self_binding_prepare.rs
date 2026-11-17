// SPDX-License-Identifier: LicenseRef-Proprietary
//! Prepare the exact command binding; submission reloads eligibility under its write lock.
use crate::{PgOrgError, PgOrgStore, account_link_solo};
use console_kernel_core::{KernelError, OrgId, UserId};
use console_platform_auth::{MobilePasskeyStepUpBinding, MobileStepUpActionKind};
use console_platform_authz::cedar_pbac::actions::account_link_record;
use console_platform_db::with_org_conn;
use console_platform_request_context::current_org;
use serde_json::json;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

pub(crate) async fn binding_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    employee: Uuid,
    confirmed_name: Option<&str>,
) -> Result<MobilePasskeyStepUpBinding, PgOrgError> {
    let mut payload = json!({"command":"account_link.self_bind","org_id":org,"account_id":actor,"employee_id":employee});
    if let Some(name) = confirmed_name {
        payload["confirmed_name"] = json!(name);
    }
    let hash: String =
        sqlx::query_scalar("SELECT governed_exception_fingerprint($1,'{}'::daterange[])")
            .bind(payload)
            .fetch_one(tx.as_mut())
            .await?;
    Ok(MobilePasskeyStepUpBinding::bound(
        MobileStepUpActionKind::ExceptionDecide,
        *actor.as_uuid(),
        hash,
    ))
}

pub(crate) async fn record_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    employee: Uuid,
    confirmed_name: Option<&str>,
) -> Result<account_link_record::Facts, PgOrgError> {
    let (matches_record, any_match, name_confirmed): (bool, bool, bool) = sqlx::query_as(
        "SELECT btrim(u.display_name)<>'' AND btrim(u.display_name)=btrim(e.name), \
         EXISTS(SELECT 1 FROM person_employees_current m WHERE m.org_id=u.org_id AND btrim(u.display_name)<>'' AND btrim(m.name)=btrim(u.display_name)), \
         COALESCE(e.name=$4 AND btrim(e.name)<>'',false) \
         FROM person_accounts_current u JOIN person_employees_current e ON e.org_id=u.org_id AND e.id=$3 WHERE u.org_id=$1 AND u.id=$2")
        .bind(org.as_uuid()).bind(actor.as_uuid()).bind(employee).bind(confirmed_name)
        .fetch_one(tx.as_mut()).await?;
    let facts = account_link_record::Facts {
        matches_record,
        any_match,
        name_confirmed,
    };
    if !account_link_record::decide(
        &actor.to_string(),
        &org.to_string(),
        &org.to_string(),
        facts,
    )
    .map_err(KernelError::internal)?
    {
        return Err(KernelError::forbidden("Choose the record matching your account, or confirm its full name when no record matches")
            .with_code("account_link.refuse.not_own_record").into());
    }
    Ok(facts)
}

impl PgOrgStore {
    /// Offer a command-bound passkey ceremony only after Cedar admits this operator.
    /// # Errors
    /// Ineligible actor, missing employee, or employee already linked to an account.
    pub async fn prepare_self_binding(
        &self,
        actor: UserId,
        employee: Uuid,
        confirmed_name: Option<String>,
    ) -> Result<MobilePasskeyStepUpBinding, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn(&self.pool, org, move |tx| {
            Box::pin(async move {
                if !account_link_solo::eligibility_in_tx(tx, org, actor, actor).await? {
                    return Err(KernelError::forbidden(
                        "Self-binding is available only to an unlinked sole operator",
                    )
                    .with_code("account_link.refuse.solo_ineligible")
                    .into());
                }
                let taken: Option<bool> = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM users WHERE org_id=$1 AND employee_id=$2) \
                FROM employees WHERE org_id=$1 AND id=$2",
                )
                .bind(org.as_uuid())
                .bind(employee)
                .fetch_optional(tx.as_mut())
                .await?;
                match taken {
                    None => return Err(KernelError::not_found("Employee record not found").into()),
                    Some(true) => {
                        return Err(KernelError::conflict(
                            "Employee is already linked to another account",
                        )
                        .with_code("account_link.refuse.employee_taken")
                        .into());
                    }
                    Some(false) => {}
                }
                record_in_tx(tx, org, actor, employee, confirmed_name.as_deref()).await?;
                binding_in_tx(tx, org, actor, employee, confirmed_name.as_deref()).await
            })
        })
        .await
    }
}
