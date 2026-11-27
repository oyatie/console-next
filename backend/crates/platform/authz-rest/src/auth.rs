// SPDX-License-Identifier: LicenseRef-Proprietary
//! Admin authorization helper for Cedar Policy Studio REST handlers.

use axum::http::HeaderMap;
use console_kernel_core::KernelError;
use console_platform_authz::access::{
    AccessSlice, Domain, Level, NodePath, action_group, load_access_subject,
};
use console_platform_authz::{Action, Feature, Principal, authorize_org_wide};
use time::OffsetDateTime;

use crate::{CedarPolicyRestState, RestError, rest_error_from_request_context};

pub(crate) async fn authorize_admin(
    state: &CedarPolicyRestState,
    headers: &HeaderMap,
) -> Result<Principal, RestError> {
    let verifier = state.jwt_verifier.as_ref().ok_or_else(|| {
        RestError::unavailable("JWT verification is not configured for policy API")
    })?;
    let principal =
        console_platform_request_context::resolve_principal(verifier, state.store.pool(), headers)
            .await
            .map_err(rest_error_from_request_context)?;
    if authorize_org_wide(&principal, Action::new(Feature::RoleManage)).is_ok() {
        return Ok(principal);
    }
    let org = principal.org_id;
    let user_uuid = *principal.user_id.as_uuid();
    let holds_tenant_access_edit = console_platform_db::with_org_conn::<_, _, KernelError>(
        state.store.pool(),
        org,
        move |tx| {
            Box::pin(async move {
                let subject =
                    load_access_subject(tx, org, user_uuid, OffsetDateTime::now_utc()).await?;
                let ok = AccessSlice::compile(&subject).ok().is_some_and(|slice| {
                    slice
                        .allows(
                            &action_group(Domain::Access, Level::Edit),
                            &NodePath::tenant(org),
                        )
                        .unwrap_or(false)
                });
                Ok(ok)
            })
        },
    )
    .await
    .map_err(RestError::from_kernel)?;
    if holds_tenant_access_edit {
        return Ok(principal);
    }
    authorize_org_wide(&principal, Action::new(Feature::RoleManage))
        .map_err(RestError::from_kernel)?;
    Ok(principal)
}
