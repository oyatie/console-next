// SPDX-License-Identifier: LicenseRef-Proprietary
//! Independent review retains the receipt and never changes a replacement binding.
use crate::{PgOrgError, PgOrgStore, policy::versions::bump_subject_version_tx};
use console_identity_application::user_audit_event;
use console_kernel_core::{KernelError, TraceContext, UserId};
use console_platform_auth::VerifiedStepUp;
use console_platform_authz::access::{NodeKind, NodeRef};
use console_platform_authz::cedar_pbac::{
    actions::{account_link_review, independent_people},
    visible::load_facts,
};
use console_platform_db::with_phase_audits;
use console_platform_request_context::current_org;
use serde_json::json;
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Clone, Copy)]
pub enum ReviewDecision {
    Confirm,
    Revoke,
}

impl PgOrgStore {
    /// Apply an independent review with current Cedar facts and a verified reviewer.
    /// # Errors
    /// Missing receipt, unbound/ineligible reviewer, stale binding or repeated decision.
    pub async fn review_self_binding(
        &self,
        receipt: Uuid,
        decision: ReviewDecision,
        step_up: VerifiedStepUp,
        trace: TraceContext,
    ) -> Result<(), PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let actor = UserId::from_uuid(step_up.into_user_id());
        with_phase_audits(&self.pool, org, move |tx| Box::pin(async move {
            let facts = load_facts(tx, org, *actor.as_uuid()).await?;
            let eligible = facts.authorize(console_platform_authz::Feature::UserManage.as_str(),
                NodeRef { kind: NodeKind::Tenant, id: *org.as_uuid() })
                .map_err(|error| KernelError::internal(error.to_string()))?;
            if !eligible {
                return Err(KernelError::forbidden("Account management permission is required").with_code("account_link.refuse.review_ineligible").into());
            }
            let row: Option<(Uuid, Uuid)> = sqlx::query_as(
                "SELECT account_id,employee_id FROM account_link_self_attestations WHERE org_id=$1 AND id=$2")
                .bind(org.as_uuid()).bind(receipt).fetch_optional(tx.as_mut()).await?;
            let (account, employee) = row.ok_or_else(|| KernelError::not_found("Self-attestation not found"))?;
            sqlx::query("SELECT id FROM users WHERE org_id=$1 AND id=ANY($2) ORDER BY id FOR UPDATE")
                .bind(org.as_uuid()).bind(vec![account, *actor.as_uuid()]).fetch_all(tx.as_mut()).await?;
            let (linked, confirmed, revoked): (bool, bool, bool) = sqlx::query_as(
                "SELECT employee_id IS NOT DISTINCT FROM $3, \
                    EXISTS(SELECT 1 FROM account_link_self_reviews WHERE org_id=$1 AND attestation_id=$4 AND decision='CONFIRM'), \
                    EXISTS(SELECT 1 FROM account_link_self_reviews WHERE org_id=$1 AND attestation_id=$4 AND decision='REVOKE') \
                 FROM users WHERE org_id=$1 AND id=$2")
                .bind(org.as_uuid()).bind(account).bind(employee).bind(receipt).fetch_one(tx.as_mut()).await?;
            if !linked || revoked || (confirmed && matches!(decision, ReviewDecision::Confirm)) {
                return Err(KernelError::conflict("This self-attested binding has already changed").with_code("account_link.refuse.review_stale").into());
            }
            let independent = independent_people::refusal_in_tx(tx.as_mut(), Some(account), *actor.as_uuid()).await;
            if !account_link_review::decide(&actor.to_string(), &org.to_string(), &org.to_string(),
                independent.is_none(), eligible).map_err(KernelError::internal)? {
                let code = independent.map_or("account_link.refuse.review_ineligible", |refusal|
                    refusal.code("account_link.refuse.identity_unbound", "account_link.refuse.review_ineligible"));
                return Err(KernelError::forbidden("An independent account manager must review this binding").with_code(code).into());
            }
            let now: OffsetDateTime = sqlx::query_scalar("SELECT clock_timestamp()").fetch_one(tx.as_mut()).await?;
            let (verdict, action) = match decision {
                ReviewDecision::Confirm => ("CONFIRM", "account_link.confirmed"),
                ReviewDecision::Revoke => ("REVOKE", "account_link.revoked"),
            };
            sqlx::query("INSERT INTO account_link_self_reviews(org_id,attestation_id,decision,reviewer_id,reviewed_at) VALUES($1,$2,$3,$4,$5)")
                .bind(org.as_uuid()).bind(receipt).bind(verdict).bind(actor.as_uuid()).bind(now).execute(tx.as_mut()).await?;
            if matches!(decision, ReviewDecision::Revoke) {
                sqlx::query("UPDATE users SET employee_id=NULL WHERE org_id=$1 AND id=$2")
                    .bind(org.as_uuid()).bind(account).execute(tx.as_mut()).await?;
            }
            bump_subject_version_tx(tx, *org.as_uuid(), account, now).await?;
            let after = if matches!(decision, ReviewDecision::Revoke) { None } else { Some(employee) };
            let event = user_audit_event(action, Some(actor), UserId::from_uuid(account), trace, now)?.with_org(org)
                .with_snapshots(Some(json!({"employee_id":employee})),
                    Some(json!({"employee_id":after,"self_attestation_id":receipt,"decision":verdict})));
            Ok(((), vec![event]))
        })).await
    }
}
