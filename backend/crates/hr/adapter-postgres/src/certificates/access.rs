// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::{
    HrError,
    authz::{HrCaseFacts, hr_reach},
};
use console_platform_authz::{
    Feature, Principal,
    access::{AccessSlice, NodeKind, NodePath, NodeRef, load_active_access_slice},
    cedar_pbac::actions::certificates,
};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

pub(super) fn feature(action: &str) -> Feature {
    if action == certificates::SETTINGS_MANAGE {
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
    .map_err(|error| HrError::internal(format!("certificate permission unavailable: {error}")))?;
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

pub(super) struct TenantFacts {
    slice: AccessSlice,
}

pub(super) async fn tenant_facts(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
) -> Result<TenantFacts, HrError> {
    let slice = load_active_access_slice(
        tx,
        principal.org_id,
        *principal.user_id.as_uuid(),
        time::OffsetDateTime::now_utc(),
    )
    .await
    .map_err(|error| {
        if error.status_code() == http::StatusCode::FORBIDDEN.as_u16() {
            super::refused(
                http::StatusCode::FORBIDDEN,
                "certificate_forbidden",
                "certificate permission is required in this scope",
            )
        } else {
            HrError::from_kernel(error)
        }
    })?;
    Ok(TenantFacts { slice })
}

pub(super) fn tenant_decision(
    facts: &TenantFacts,
    principal: &Principal,
    action: &str,
) -> Result<bool, HrError> {
    let tenant = NodePath::tenant(principal.org_id);
    let holds = facts.slice.allows(action, &tenant).map_err(|error| {
        HrError::internal(format!("certificate permission unavailable: {error}"))
    })?;
    certificates::decide(
        action,
        &principal.user_id.to_string(),
        &principal.org_id.to_string(),
        &principal.org_id.to_string(),
        holds,
    )
    .map_err(|error| HrError::internal(format!("certificate permission unavailable: {error}")))
}

pub(super) fn require_tenant(
    facts: &TenantFacts,
    principal: &Principal,
    action: &str,
) -> Result<(), HrError> {
    if tenant_decision(facts, principal, action)? {
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
) -> Result<Option<Uuid>, HrError> {
    let facts = console_platform_authz::cedar_pbac::visible::load_facts(
        tx,
        principal.org_id,
        *principal.user_id.as_uuid(),
    )
    .await
    .map_err(HrError::from_kernel)?;
    let people = HrCaseFacts::load(tx, *principal.user_id.as_uuid(), &[id]).await?;
    let holds = facts
        .authorize(
            feature(action).as_str(),
            NodeRef {
                kind: NodeKind::Tenant,
                id: *principal.org_id.as_uuid(),
            },
        )
        .map_err(|error| {
            HrError::internal(format!("certificate permission unavailable: {error}"))
        })?
        || people.permits(&facts, principal.org_id, id, feature(action))?;
    decide(principal, action, holds)?;
    Ok(people
        .placement(id)
        .ok_or_else(super::not_found)?
        .legal_entity_id)
}
