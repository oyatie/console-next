// SPDX-License-Identifier: LicenseRef-Proprietary
//! Session snapshots for support read, scope and field decisions.
use super::{DecisionFacts, db};
use crate::cedar_pbac::actions::support_session::{self, Action, Facts, PrincipalKind};
use crate::{Feature, SupportPrincipal, access};
use console_kernel_core::{KernelError, OrgId, UserId};
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

impl DecisionFacts {
    /// Tenant consent uses the live account and the same Cedar snapshot as visible sets.
    pub async fn support_session(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        session: Option<Uuid>,
    ) -> Result<Facts, KernelError> {
        let (_, operator_approved, tenant_approved) = transition(tx, self.org, session).await?;
        Ok(Facts {
            active: true,
            vendor: false,
            step_up: false,
            other_eligible_holders: 0,
            actor_is_requester: false,
            actor_holds_permission: self
                .authorize(
                    "support_access::approve",
                    crate::access::NodeRef {
                        kind: crate::access::NodeKind::Tenant,
                        id: *self.org.as_uuid(),
                    },
                )
                .map_err(|e| KernelError::internal(e.to_string()))?,
            operator_approved,
            tenant_approved,
            in_scope: false,
            personal: false,
            reveal_granted: false,
        })
    }
}

async fn transition(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    session: Option<Uuid>,
) -> Result<(Option<Uuid>, bool, bool), KernelError> {
    let Some(id) = session else {
        return Ok((None, false, false));
    };
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .map_err(db)?;
    sqlx::query_as("SELECT operator_ref,operator_approver_ref IS NOT NULL,tenant_approved_at IS NOT NULL FROM support_sessions WHERE org_id=$1 AND id=$2 AND row_security_active('support_sessions') FOR UPDATE")
        .bind(org.as_uuid()).bind(id).fetch_one(tx.as_mut()).await.map_err(db)
}

/// Load live operator authority and the eligible second-person set.
/// The assertion pair is the verified ceremony and its bound support object.
pub async fn load_operator_facts(
    tx: &mut Transaction<'_, Postgres>,
    operator: UserId,
    assertion: Option<(Uuid, Uuid)>,
    session: Option<(OrgId, Uuid)>,
) -> Result<Facts, KernelError> {
    let org = OrgId::platform();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .map_err(db)?;
    let account = super::load_facts(tx, org, *operator.as_uuid()).await?;
    // shortcut: legacy operator roles, replace when the operator registry owns support eligibility.
    let vendor = crate::PlatformPrincipal::accepts_roles(account.roles());
    let candidates: Vec<Vec<String>> = sqlx::query_scalar("SELECT u.roles FROM users u WHERE org_id=$1 AND u.id<>$2 AND u.is_active AND EXISTS(SELECT 1 FROM auth_webauthn_credentials c WHERE c.user_id=u.id AND c.passkey_json#>>'{cred,backup_eligible}'='false')")
        .bind(org.as_uuid()).bind(operator.as_uuid()).fetch_all(tx.as_mut()).await.map_err(db)?;
    let other_eligible_holders = i64::try_from(
        candidates
            .iter()
            .filter(|roles| crate::PlatformPrincipal::accepts_roles(roles))
            .count(),
    )
    .map_err(|e| KernelError::internal(e.to_string()))?;
    let step_up = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM step_up_assertions a JOIN auth_webauthn_credentials c ON c.id=a.credential_row_id WHERE a.org_id=$1 AND a.user_id=$2 AND a.ceremony_id=$3 AND a.action_kind='SUPPORT_SESSION' AND a.object_id=$4 AND ($5::uuid IS NULL OR a.object_id=$5) AND a.user_verified AND c.passkey_json#>>'{cred,backup_eligible}'='false')")
        .bind(org.as_uuid()).bind(operator.as_uuid()).bind(assertion.map(|a| a.0)).bind(assertion.map(|a| a.1)).bind(session.map(|s| s.1)).fetch_one(tx.as_mut()).await.map_err(db)?;
    let (requester, operator_approved, tenant_approved) = match session {
        Some((org, id)) => transition(tx, org, Some(id)).await?,
        None => (Some(*operator.as_uuid()), false, false),
    };
    Ok(Facts {
        active: true,
        vendor,
        step_up,
        other_eligible_holders,
        actor_is_requester: requester == Some(*operator.as_uuid()),
        actor_holds_permission: vendor,
        operator_approved,
        tenant_approved,
        in_scope: false,
        personal: false,
        reveal_granted: false,
    })
}
