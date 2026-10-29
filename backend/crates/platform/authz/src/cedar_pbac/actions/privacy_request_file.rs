// SPDX-License-Identifier: LicenseRef-Proprietary
//! Session identity suffices to file; HR data requires the actor's linked employee.
use super::super::action_schema::{ActionSchema, FactType, RequiredFact};
use super::super::facts::second_person::ACTOR_IS_REQUESTER;
use crate::Feature;

pub const SCHEMA: ActionSchema = ActionSchema {
    denial_codes: &[],
    feature: Feature::PrivacyRequestFile,
    version: "2026-10-privacy-request-file-v1",
    facts: &[
        ACTOR_IS_REQUESTER,
        RequiredFact {
            name: "is_hr",
            ty: FactType::Bool,
        },
        RequiredFact {
            name: "has_employee",
            ty: FactType::Bool,
        },
    ],
    policies: r#"permit(principal, action == Action::"privacy_request_file", resource)
when {
  principal.org == resource.org && context.actor_is_requester &&
  (!context.is_hr || context.has_employee)
};"#,
};
