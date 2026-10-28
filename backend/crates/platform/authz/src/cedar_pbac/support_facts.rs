// SPDX-License-Identifier: LicenseRef-Proprietary
//! Session snapshots for support read, scope and field decisions.
use super::db;
use crate::cedar_pbac::actions::support_session::{self, Action, Facts, PrincipalKind};
use crate::{Feature, SupportPrincipal, access};
use console_kernel_core::{KernelError, OrgId};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

impl SupportPrincipal {
    /// Only the loader builds authority; callers supply the reviewed resource, never scope flags.
    pub fn facts(&self, domain: Option<&str>, class: Option<&str>) -> Facts {
        Facts {
            active: self.active,
            vendor: false,
            step_up: false,
            other_eligible_holders: 0,
            actor_is_requester: false,
            actor_holds_permission: false,
            operator_approved: self.operator_approved,
            tenant_approved: self.tenant_approved,
            in_scope: domain.is_some_and(|d| self.scope.iter().any(|s| s == d)),
            personal: class.is_some_and(|c| c != "metadata"),
            reveal_granted: class.is_some_and(|c| self.reveal_classes.iter().any(|s| s == c)),
        }
    }
    pub fn field_visible(&self, domain: &str, class: &str) -> bool {
        support_session::decide(
            Action::FieldRead,
            PrincipalKind::Support,
            &self.session_id.to_string(),
            &self.org_id.to_string(),
            &self.org_id.to_string(),
            self.facts(Some(domain), Some(class)),
        )
    }
    /// Facts for the catalog's domain, shared by the feature gate and row reach.
    pub fn feature_facts(&self, feature: Feature) -> Facts {
        self.facts(
            access::tag(feature).map(|(domain, _)| domain.as_str()),
            None,
        )
    }
}

/// Refresh inside the caller's locked transaction; bypass-RLS connections refuse.
pub async fn load_support_session(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    id: Uuid,
) -> Result<SupportPrincipal, KernelError> {
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .map_err(db)?;
    sqlx::query_as("SELECT id AS session_id,org_id,operator_label,scope,reveal_classes,operator_approver_ref IS NOT NULL AS operator_approved,tenant_approved_at IS NOT NULL AS tenant_approved,state='ACTIVE' AND COALESCE(expires_at>clock_timestamp(),false) AS active FROM support_sessions WHERE org_id=$1 AND id=$2 AND row_security_active('support_sessions') FOR UPDATE")
        .bind(org.as_uuid()).bind(id).fetch_one(tx.as_mut()).await.map_err(db)
}
