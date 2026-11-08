// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::*;
use console_platform_authz::cedar_pbac::actions::{org_change_sole_holder, org_change_step_decide};
use console_settings_domain::SettingValue;

/// The viewer's first pending stored step eligible for case B, without granting a write.
/// Call after locking the request when using this snapshot to admit a decision.
/// All authority and identity facts use the ordinary decision fact loader.
///
/// # Errors
/// Database, settings and Cedar failures refuse eligibility.
pub async fn sole_holder_eligibility_in_tx(
    tx: Tx<'_, '_>,
    org: OrgId,
    actor: UserId,
    id: Uuid,
) -> Result<Option<Uuid>, PgOrgChangeError> {
    let scope = super::StepDecisionScope::Request(id);
    let Some(viewer) = super::step_decision_facts_in_tx(tx, org, actor, scope.clone())
        .await?
        .into_iter()
        .next()
    else {
        return Ok(None);
    };
    let step: Option<Uuid> = sqlx::query_scalar(
        "SELECT s.id FROM org_change_approval_steps s JOIN org_change_requests r ON r.id=s.request_id \
         WHERE r.org_id=$1 AND r.id=$2 AND r.status='IN_APPROVAL' AND s.decision='PENDING' \
         ORDER BY s.step_order LIMIT 1",
    ).bind(org.as_uuid()).bind(id).fetch_optional(tx.as_mut()).await?;
    let now = sqlx::query_scalar("SELECT now()")
        .fetch_one(tx.as_mut())
        .await?;
    let settings = console_settings_adapter_postgres::resolve_in_tx(
        tx.as_mut(),
        org,
        &[
            SettingKey::ApprovalPolicyOrgStructure,
            SettingKey::AuthzSoleHolderMode,
        ],
        None,
        now,
    )
    .await?;
    let code = |key| {
        settings
            .get(&key)
            .and_then(|v| v.as_ref().ok())
            .map(|v| v.value)
    };
    let mut facts = org_change_sole_holder::Facts {
        holds_permission: viewer.decision.holds_permission,
        identities_bound: viewer.decision.identities_bound,
        requires_exception: viewer.decision.actor_is_drafter
            || viewer.decision.actor_decided_prior_step,
        routed: code(SettingKey::ApprovalPolicyOrgStructure) == Some(SettingValue::Code("route")),
        sole_holder_allowed: code(SettingKey::AuthzSoleHolderMode)
            == Some(SettingValue::Code("step_up_notice_review")),
        pending: step.is_some(),
        other_holder: false,
    };
    let allowed = |f| {
        org_change_sole_holder::decide(&actor.to_string(), &org.to_string(), &org.to_string(), f)
            .map_err(|_| KernelError::forbidden("org sole-holder facts unavailable"))
    };
    // Avoid loading the holder set for a viewer who cannot receive an offer.
    if !allowed(org_change_sole_holder::Facts { ..facts })? {
        return Ok(None);
    }
    let candidates: Vec<Uuid> = sqlx::query_scalar(
        "SELECT u.id FROM users u WHERE u.org_id=$1 AND u.is_active AND u.id<>$2 \
         AND (u.is_tenant_ops OR EXISTS(SELECT 1 FROM access_grants g WHERE g.org_id=u.org_id AND g.account_id=u.id))",
    ).bind(org.as_uuid()).bind(actor.as_uuid()).fetch_all(tx.as_mut()).await?;
    // shortcut: candidate snapshots load separately; batch through the same loader if holder scans become costly.
    for account in candidates {
        let Some(candidate) =
            super::step_decision_facts_in_tx(tx, org, UserId::from_uuid(account), scope.clone())
                .await?
                .into_iter()
                .next()
        else {
            return Ok(None);
        };
        let f = candidate.decision;
        if !f.holds_permission {
            continue;
        }
        if !f.identities_bound {
            facts.identities_bound = false;
            break;
        }
        match org_change_step_decide::enforce(
            &account.to_string(),
            &org.to_string(),
            &org.to_string(),
            f,
        ) {
            Ok(()) => {
                facts.other_holder = true;
                break;
            }
            Err(error) if error.code == Some("org_change_sod_violation") => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(allowed(facts)?.then_some(step).flatten())
}
