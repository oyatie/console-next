// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::{
    HrError,
    authz::{hr_may_person, hr_reach},
};
use console_platform_authz::{Feature, Principal, cedar_pbac::actions::certificates};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

pub(super) fn feature(action: &str) -> Feature {
    if action.starts_with("certificate_settings") {
        Feature::OrgChangeApply
    } else {
        Feature::EmployeeDirectoryManage
    }
}
pub(super) fn decide(principal: &Principal, action: &str, holds: bool) -> Result<(), HrError> {
    let allowed = certificates::decide(
        action,
        &principal.user_id.to_string(),
        &principal.org_id.to_string(),
        &principal.org_id.to_string(),
        holds,
    )
    .unwrap_or(false);
    tracing::info!(
        action,
        allowed,
        policy = "certificate_tenant_and_grant",
        "certificate authorization"
    );
    if allowed {
        Ok(())
    } else {
        Err(super::refused(
            http::StatusCode::FORBIDDEN,
            "certificate_forbidden",
            "certificate permission is required in this scope",
        ))
    }
}
pub(super) fn capability(principal: &Principal, action: &str) -> Result<(), HrError> {
    let holds = hr_reach(principal, feature(action)).is_ok();
    decide(principal, action, holds)
}
pub(super) async fn person(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    action: &str,
    id: Uuid,
) -> Result<(), HrError> {
    capability(principal, action)?;
    let holds = hr_may_person(tx, principal, feature(action), id).await?;
    decide(principal, action, holds)
}
