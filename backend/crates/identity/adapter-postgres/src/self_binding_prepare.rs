// SPDX-License-Identifier: LicenseRef-Proprietary
//! Prepare the exact command binding; submission reloads eligibility under its write lock.
use crate::{PgOrgError, PgOrgStore, account_link_solo};
use console_kernel_core::{KernelError, OrgId, UserId};
use console_platform_auth::{MobilePasskeyStepUpBinding, MobileStepUpActionKind};
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
) -> Result<MobilePasskeyStepUpBinding, PgOrgError> {
    let payload = json!({"command":"account_link.self_bind","org_id":org,"account_id":actor,"employee_id":employee});
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

impl PgOrgStore {
    /// Offer a command-bound passkey ceremony only after Cedar admits this operator.
    /// # Errors
    /// Ineligible actor, missing employee, or employee already linked to an account.
    pub async fn prepare_self_binding(
        &self,
        actor: UserId,
        employee: Uuid,
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
                binding_in_tx(tx, org, actor, employee).await
            })
        })
        .await
    }
}
