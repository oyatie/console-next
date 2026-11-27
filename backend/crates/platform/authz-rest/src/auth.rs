// SPDX-License-Identifier: LicenseRef-Proprietary
//! Admin authorization helper for Cedar Policy Studio REST handlers.

use axum::Json;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use console_kernel_core::KernelError;
use console_platform_authz::Principal;
use console_platform_authz::access::{
    AccessSlice, Domain, Level, NodePath, action_group, load_access_subject,
};
use console_platform_db::DbError;
use serde::Serialize;
use time::OffsetDateTime;

use crate::{
    CedarPolicyRestState, RestError, check_legacy_role_manage, rest_error_from_request_context,
};

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: ErrorPayload,
}

#[derive(Debug, Serialize)]
struct ErrorPayload {
    code: &'static str,
    message: String,
}

impl IntoResponse for RestError {
    fn into_response(self) -> Response {
        let code = self.code();
        (
            self.status,
            Json(ErrorBody {
                error: ErrorPayload {
                    code,
                    message: self.message,
                },
            }),
        )
            .into_response()
    }
}

enum AuthSubjectLoadError {
    Db,
    Kernel(KernelError),
}

impl From<DbError> for AuthSubjectLoadError {
    fn from(_: DbError) -> Self {
        Self::Db
    }
}

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
    let legacy = check_legacy_role_manage(&principal);
    if legacy.is_ok() {
        return Ok(principal);
    }
    let org = principal.org_id;
    let user_uuid = *principal.user_id.as_uuid();
    let holds_tenant_access_edit =
        console_platform_db::with_org_conn::<_, _, AuthSubjectLoadError>(
            state.store.pool(),
            org,
            move |tx| {
                Box::pin(async move {
                    let subject =
                        load_access_subject(tx, org, user_uuid, OffsetDateTime::now_utc())
                            .await
                            .map_err(AuthSubjectLoadError::Kernel)?;
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
        .map_err(|err| match err {
            AuthSubjectLoadError::Db => RestError::internal("internal server error"),
            AuthSubjectLoadError::Kernel(k) => RestError::from_kernel(k),
        })?;
    if holds_tenant_access_edit {
        return Ok(principal);
    }
    legacy.map_err(RestError::from_kernel)?;
    Ok(principal)
}
