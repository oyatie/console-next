// SPDX-License-Identifier: LicenseRef-Proprietary
//! Current self-attestation for the authenticated account; historical receipts stay private.
use crate::{PgOrgError, PgOrgStore};
use console_kernel_core::{KernelError, UserId};
use console_platform_authz::cedar_pbac::{
    actions::{account_link_receipt, account_link_withdraw},
    visible::load_facts,
};
use console_platform_db::with_org_conn;
use console_platform_request_context::current_org;
use serde_json::{Value, json};
use uuid::Uuid;

impl PgOrgStore {
    /// Read only the actor's current self-attestation and Cedar withdrawal decision.
    /// # Errors
    /// Missing tenant context, inactive account, or unavailable Cedar facts.
    pub async fn self_binding_receipt(&self, actor: UserId) -> Result<Value, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn(&self.pool, org, |tx| Box::pin(async move {
            let facts = load_facts(tx, org, *actor.as_uuid()).await?;
            let (subject, _) = facts.access_permissions(org, *actor.as_uuid())?;
            if !account_link_receipt::decide(&actor.to_string(), &org.to_string(), &org.to_string(), subject.account == *actor.as_uuid())
                .map_err(KernelError::internal)? {
                return Err(KernelError::forbidden("Binding receipt belongs to another account").into());
            }
            let row: Option<(Uuid, Uuid, bool)> = sqlx::query_as(
                "SELECT a.id,a.employee_id,NOT EXISTS(SELECT 1 FROM account_link_self_reviews r WHERE r.org_id=a.org_id AND r.attestation_id=a.id) \
                 FROM account_link_self_attestations a JOIN users u ON u.org_id=a.org_id AND u.id=a.account_id AND u.employee_id=a.employee_id \
                 WHERE a.org_id=$1 AND a.account_id=$2 AND NOT EXISTS(SELECT 1 FROM account_link_self_reviews r WHERE r.org_id=a.org_id AND r.attestation_id=a.id AND r.decision='REVOKE') \
                 ORDER BY a.attested_at DESC,a.id DESC LIMIT 1")
                .bind(org.as_uuid()).bind(actor.as_uuid()).fetch_optional(tx.as_mut()).await?;
            let attestation = row.map(|(id, employee, pending)| {
                let can_withdraw = account_link_withdraw::decide(&actor.to_string(), &org.to_string(), &org.to_string(), subject.account == *actor.as_uuid(), pending)
                    .map_err(KernelError::internal)?;
                Ok::<_, KernelError>(json!({"attestation_id":id,"employee_id":employee,"can_withdraw":can_withdraw}))
            }).transpose()?;
            Ok(json!({"attestation":attestation}))
        })).await
    }
}
