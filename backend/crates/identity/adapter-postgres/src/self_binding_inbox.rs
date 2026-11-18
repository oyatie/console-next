// SPDX-License-Identifier: LicenseRef-Proprietary
//! Pending independent reviews share the command's Cedar policy and canonical identity facts.
use crate::{PgOrgError, PgOrgStore};
use console_kernel_core::{KernelError, UserId};
use console_platform_authz::{
    Feature,
    access::{NodeKind, NodeRef},
    cedar_pbac::{
        actions::{account_link_review, independent_people},
        visible::load_facts_with_access,
    },
};
use console_platform_db::with_org_conn;
use console_platform_request_context::{current_access_snapshot, current_org};
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(sqlx::FromRow)]
pub struct PendingSelfBinding {
    pub id: Uuid,
    pub employee_id: Uuid,
    pub employee_name: String,
    pub account_name: String,
    pub attested_at: OffsetDateTime,
    pub due: OffsetDateTime,
    maker_person: Option<Uuid>,
    checker_person: Option<Uuid>,
}

impl PgOrgStore {
    /// Load pending review facts in one set query, independent of the employee count.
    /// # Errors
    /// Missing tenant context, unavailable database or Cedar facts.
    pub async fn pending_self_binding_reviews(
        &self,
        actor: UserId,
    ) -> Result<Vec<PendingSelfBinding>, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn(&self.pool, org, |tx| Box::pin(async move {
            let facts = load_facts_with_access(tx, org, *actor.as_uuid(), current_access_snapshot(org, *actor.as_uuid())).await?;
            let eligible = facts.authorize(Feature::UserManage.as_str(), NodeRef { kind: NodeKind::Tenant, id: *org.as_uuid() })
                .map_err(|error| KernelError::internal(error.to_string()))?;
            if !account_link_review::decide(&actor.to_string(), &org.to_string(), &org.to_string(), true, eligible)
                .map_err(KernelError::internal)? { return Ok(Vec::new()); }
            let rows: Vec<PendingSelfBinding> = sqlx::query_as(
                "SELECT a.id,a.employee_id,e.name AS employee_name,u.display_name AS account_name,a.attested_at,a.review_due_at AS due,p.maker_person,p.checker_person \
                 FROM account_link_self_attestations a \
                 JOIN person_accounts_current u ON u.org_id=a.org_id AND u.id=a.account_id AND u.employee_id=a.employee_id \
                 JOIN person_employees_current e ON e.org_id=a.org_id AND e.id=a.employee_id \
                 CROSS JOIN LATERAL console_decision_people(a.org_id,a.account_id,$2) p \
                 WHERE a.org_id=$1 AND NOT EXISTS(SELECT 1 FROM account_link_self_reviews r WHERE r.org_id=a.org_id AND r.attestation_id=a.id)")
                .bind(org.as_uuid()).bind(actor.as_uuid()).fetch_all(tx.as_mut()).await?;
            let mut visible = Vec::new();
            for row in rows {
                let independent = independent_people::decide_people(*org.as_uuid(), *actor.as_uuid(), row.maker_person, row.checker_person).map_err(KernelError::internal)?;
                if account_link_review::decide(&actor.to_string(), &org.to_string(), &org.to_string(), independent, eligible).map_err(KernelError::internal)? {
                    visible.push(row);
                }
            }
            Ok(visible)
        })).await
    }
}
