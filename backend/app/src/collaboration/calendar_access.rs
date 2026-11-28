// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{CollaborationError, ScopeType, authorize_collaboration_member};
use console_kernel_core::BranchId;
use console_notices_rest::authorize_publication;
use console_platform_authz::Principal;
use uuid::Uuid;

/// Calendar publication uses the announcement permission against the audience actually addressed.
pub(super) fn authorize_audience(
    principal: &Principal,
    scope: ScopeType,
    target: Option<&str>,
) -> Result<Option<Uuid>, CollaborationError> {
    match scope {
        ScopeType::Personal => Ok(None),
        ScopeType::Department => {
            let branch = target
                .and_then(|s| Uuid::parse_str(s).ok())
                .ok_or_else(|| {
                    CollaborationError::validation("department calendar events require a branch")
                })?;
            authorize_publication(principal, Some(BranchId::from_uuid(branch)))
                .map(|()| Some(branch))
                .map_err(CollaborationError::from_kernel)
        }
        // Team names do not identify a single branch. An audience spanning branches requires
        // the same authority as publishing an organization-wide notice.
        ScopeType::Tenant | ScopeType::Org | ScopeType::Team => {
            authorize_publication(principal, None)
                .map(|()| None)
                .map_err(CollaborationError::from_kernel)
        }
    }
}

/// Actual membership opens personal events; the announcement action is separately scoped.
pub(crate) fn calendar_access(principal: &Principal) -> bool {
    authorize_collaboration_member(principal).is_ok()
}

pub(super) async fn require_active_branch(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: console_kernel_core::OrgId,
    branch: Uuid,
) -> Result<(), CollaborationError> {
    let available = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM branches WHERE org_id=$1 AND id=$2 AND deactivated_at IS NULL FOR SHARE",
    )
    .bind(org.as_uuid())
    .bind(branch)
    .fetch_optional(tx.as_mut())
    .await?;
    if available.is_none() {
        return Err(CollaborationError::validation(
            "department calendar events require an active branch",
        ));
    }
    Ok(())
}
