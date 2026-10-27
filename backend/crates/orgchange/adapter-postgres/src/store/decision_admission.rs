// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::*;
use console_orgchange_domain::{StepDecisionCommand, decision_version};
use console_platform_authz::access::{NodeKind, NodeRef};
use console_platform_authz::cedar_pbac::{
    actions::{
        independent_people::{self, Refusal},
        org_change_step_decide::{self, Facts},
    },
    visible::load_facts,
};

pub(super) async fn admit(
    tx: Tx<'_, '_>,
    org: OrgId,
    actor: UserId,
    id: Uuid,
    request: &RequestRow,
    command: &StepDecisionCommand,
) -> Result<(), PgOrgChangeError> {
    let facts = load_facts(tx, org, *actor.as_uuid()).await?;
    // shortcut: tenant-wide approval authority, bind each step when tenant role bindings are stored.
    let holds_permission = facts
        .authorize(
            "org_change_approve",
            NodeRef {
                kind: NodeKind::Tenant,
                id: *org.as_uuid(),
            },
        )
        .map_err(|_| KernelError::forbidden("org approval facts unavailable"))?;
    if !holds_permission {
        return Err(KernelError::forbidden("org approval permission required").into());
    }
    if request.status == OrgChangeStatus::Cancelled {
        return Err(KernelError::conflict("org change was cancelled")
            .with_code("lifecycle.refuse.withdrawn")
            .into());
    }
    let timestamp: OffsetDateTime = sqlx::query_scalar(
        "SELECT greatest(r.updated_at, max(s.decided_at)) FROM org_change_requests r \
         LEFT JOIN org_change_approval_steps s ON s.request_id=r.id WHERE r.id=$1 GROUP BY r.updated_at",
    ).bind(id).fetch_one(tx.as_mut()).await?;
    let version = decision_version(timestamp, None);
    if command
        .expected_version
        .as_ref()
        .is_some_and(|expected| expected != &version)
    {
        return Err(PgOrgChangeError::StaleVersion(version));
    }
    let (bound, repeated): (bool, bool) = sqlx::query_as(
        "SELECT coalesce(bool_and(p.maker_person IS NOT NULL AND p.checker_person IS NOT NULL),true), \
         coalesce(bool_or(s.decided_by=$3 OR p.maker_person=p.checker_person),false) \
         FROM org_change_approval_steps s CROSS JOIN LATERAL public.console_decision_people($1,s.decided_by,$3) p \
         WHERE s.request_id=$2 AND s.decision <> 'PENDING'",
    ).bind(org.as_uuid()).bind(id).bind(actor.as_uuid()).fetch_one(tx.as_mut()).await
        .map_err(|_| KernelError::forbidden("org approval identities unavailable").with_code("org_change.refuse.identity_unbound"))?;
    let drafter =
        independent_people::refusal_in_tx(tx.as_mut(), Some(request.drafted_by), *actor.as_uuid())
            .await;
    org_change_step_decide::enforce(
        &actor.to_string(),
        &org.to_string(),
        &org.to_string(),
        Facts {
            holds_permission,
            identities_bound: bound && drafter != Some(Refusal::IdentityUnbound),
            actor_is_drafter: drafter == Some(Refusal::SamePerson),
            actor_decided_prior_step: repeated,
            merge_requested: command.through_step.is_some(),
        },
    )?;
    Ok(())
}
