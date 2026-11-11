// SPDX-License-Identifier: LicenseRef-Proprietary
//! The one way to a step decision, shared by this crate's route and the
//! approval document.
use crate::*;

/// The one way to a step decision: this route's permission floor, command
/// and refusals, for a caller that already holds the request's principal
/// (the approval document decides through it).
///
/// # Errors
/// The refusal the step-decision route answers with.
pub async fn decide_step_as(
    store: &PgOrgChangeStore,
    principal: &Principal,
    id: Uuid,
    step_id: Uuid,
    command: console_orgchange_domain::StepDecisionCommand,
) -> Result<console_orgchange_domain::OrgChangeDetail, OrgChangeRefusal> {
    allow_approve(principal)?;
    store
        .decide_step_command(principal.user_id, id, step_id, command)
        .await
        .map_err(RestError::store)
}
