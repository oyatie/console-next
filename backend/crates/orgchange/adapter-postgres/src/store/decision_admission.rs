// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::*;
use console_orgchange_domain::{StepDecisionCommand, decision_version};
use console_platform_authz::cedar_pbac::actions::org_change_step_decide;

pub(super) async fn admit(
    tx: Tx<'_, '_>,
    org: OrgId,
    actor: UserId,
    id: Uuid,
    request: &RequestRow,
    command: &StepDecisionCommand,
) -> Result<(), PgOrgChangeError> {
    let facts = super::step_decision_facts_in_tx(tx, org, actor, Some(id))
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| KernelError::not_found("org change not found"))?
        .1;
    if !facts.holds_permission {
        org_change_step_decide::enforce(
            &actor.to_string(),
            &org.to_string(),
            &org.to_string(),
            facts,
        )?;
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
    org_change_step_decide::enforce(
        &actor.to_string(),
        &org.to_string(),
        &org.to_string(),
        org_change_step_decide::Facts {
            merge_requested: command.through_step.is_some(),
            ..facts
        },
    )?;
    Ok(())
}
