// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::*;
use console_platform_authz::{
    Feature,
    cedar_pbac::{actions::org_change_cancel, visible::DecisionFacts},
};

pub(super) async fn admit(
    tx: Tx<'_, '_>,
    org: OrgId,
    actor: UserId,
    request: &RequestRow,
    access: &DecisionFacts,
) -> Result<(), PgOrgChangeError> {
    let holds =
        |feature| super::draft_admission::allows(access, org, actor, feature, &request.target);
    let holds_permission = holds(Feature::OrgChangeDraft)?;
    let in_approval = request.status == OrgChangeStatus::InApproval;
    let actor_is_drafter = request.drafted_by == *actor.as_uuid();
    org_change_cancel::enforce(
        &actor.to_string(),
        &org.to_string(),
        &org.to_string(),
        org_change_cancel::Facts {
            holds_permission,
            actor_is_drafter,
            in_approval,
        },
    )?;
    may_touch_scheduled(tx, org, request, holds(Feature::OrgChangeApply)?).await?;
    Ok(())
}
