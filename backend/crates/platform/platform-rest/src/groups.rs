use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use console_platform_authz::{PlatformFeature, PlatformPrincipal};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::dto::{GroupAccountResponse, GroupResponse, OrgResponse};
use crate::step_up::{PlatformStepUpRequest, require_platform_step_up};
use crate::{PlatformError, PlatformRestState};

fn require_group_manage(principal: &PlatformPrincipal, message: &str) -> Result<(), PlatformError> {
    principal
        .authorize(PlatformFeature::GroupManage)
        .map_err(|_| PlatformError::forbidden(message))
}

/// GET /api/platform/groups — list all top-level groups and their member org identities.
pub(crate) async fn list_groups(
    State(state): State<PlatformRestState>,
    Extension(principal): Extension<PlatformPrincipal>,
    Extension(claims): Extension<console_platform_auth::AccessClaims>,
) -> Result<Response, PlatformError> {
    require_group_manage(&principal, "platform principal cannot list groups")?;
    let mut tx = crate::listing_authority::begin(
        &state,
        &principal,
        &claims,
        "groups",
        "platform principal cannot list groups",
    )
    .await?;

    let groups = state
        .provisioner
        .list_groups_in_tx(&mut tx, Some(principal.user_id), OffsetDateTime::now_utc())
        .await
        .map_err(PlatformError::from_provisioning)?;
    tx.commit()
        .await
        .map_err(crate::listing_authority::storage_error)?;

    let items: Vec<GroupResponse> = groups.into_iter().map(GroupResponse::from).collect();
    Ok(Json(items).into_response())
}

/// GET /api/platform/groups/{id}/accounts — list tenant-anchored group accounts.
pub(crate) async fn list_group_accounts(
    State(state): State<PlatformRestState>,
    Extension(principal): Extension<PlatformPrincipal>,
    Path(id): Path<Uuid>,
) -> Result<Response, PlatformError> {
    require_group_manage(&principal, "platform principal cannot list group accounts")?;

    let accounts = state
        .provisioner
        .list_group_accounts(
            &state.pool,
            Some(principal.user_id),
            id,
            OffsetDateTime::now_utc(),
        )
        .await
        .map_err(PlatformError::from_provisioning)?;

    let items: Vec<GroupAccountResponse> = accounts
        .into_iter()
        .map(GroupAccountResponse::from)
        .collect();
    Ok(Json(items).into_response())
}

/// DELETE /api/platform/groups/{id}/accounts/{user_id}/roles/{group_role}.
pub(crate) async fn revoke_group_role(
    State(state): State<PlatformRestState>,
    Extension(principal): Extension<PlatformPrincipal>,
    Path((id, user_id, group_role)): Path<(Uuid, Uuid, String)>,
) -> Result<Response, PlatformError> {
    require_group_manage(&principal, "platform principal cannot revoke group roles")?;

    state
        .provisioner
        .revoke_group_role(
            &state.pool,
            Some(principal.user_id),
            id,
            user_id,
            &group_role,
            OffsetDateTime::now_utc(),
        )
        .await
        .map_err(PlatformError::from_provisioning)?;

    Ok(StatusCode::NO_CONTENT.into_response())
}

/// PUT /api/platform/groups/{id}/organizations/{org_id} — assign/move org into group.
pub(crate) async fn assign_org_to_group(
    State(state): State<PlatformRestState>,
    Extension(principal): Extension<PlatformPrincipal>,
    Path((id, org_id)): Path<(Uuid, Uuid)>,
    body: Option<Json<PlatformStepUpRequest>>,
) -> Result<Response, PlatformError> {
    require_group_manage(&principal, "platform principal cannot assign group members")?;
    // Group accounts reach every org in their group: adding an org extends
    // that reach, so it takes the same step-up as creating an account.
    require_platform_step_up(
        &state,
        &principal,
        body.and_then(|Json(body)| body.step_up),
        console_platform_request_context::PASSKEY_REQUIRED_MESSAGE,
        "assigning an organization to a group requires a step-up assertion of your passkey",
    )
    .await?;

    let org = state
        .provisioner
        .assign_org_to_group(
            &state.pool,
            Some(principal.user_id),
            id,
            org_id,
            OffsetDateTime::now_utc(),
        )
        .await
        .map_err(PlatformError::from_provisioning)?;

    Ok(Json(OrgResponse::from(org)).into_response())
}

/// DELETE /api/platform/groups/{id}/organizations/{org_id} — remove org from group.
pub(crate) async fn remove_org_from_group(
    State(state): State<PlatformRestState>,
    Extension(principal): Extension<PlatformPrincipal>,
    Path((id, org_id)): Path<(Uuid, Uuid)>,
) -> Result<Response, PlatformError> {
    require_group_manage(&principal, "platform principal cannot remove group members")?;

    let org = state
        .provisioner
        .remove_org_from_group(
            &state.pool,
            Some(principal.user_id),
            id,
            org_id,
            OffsetDateTime::now_utc(),
        )
        .await
        .map_err(PlatformError::from_provisioning)?;

    Ok(Json(OrgResponse::from(org)).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn list_groups_rejects_restricted_platform_principal() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://console_rt@127.0.0.1:5432/console_contract")
            .unwrap();
        let state = PlatformRestState::new(
            pool,
            None,
            console_platform_provisioning::PlatformProvisioner::new(time::Duration::minutes(15)),
        );
        let user_id = console_kernel_core::UserId::new();
        let restricted: PlatformPrincipal = serde_json::from_value(serde_json::json!({
            "user_id": user_id,
            "features": ["tenant_list"]
        }))
        .unwrap();
        let claims: console_platform_auth::AccessClaims =
            serde_json::from_value(serde_json::json!({
                "sub": user_id.as_uuid().to_string(),
                "org": console_kernel_core::OrgId::platform().as_uuid().to_string(),
                "roles": ["SUPER_ADMIN"],
                "branches": [],
                "platform": true,
                "iss": "",
                "aud": "",
                "iat": 0,
                "nbf": 0,
                "exp": 9_999_999_999_i64,
                "jti": Uuid::new_v4().to_string(),
                "alg": "ES256"
            }))
            .unwrap();
        let err = list_groups(State(state), Extension(restricted), Extension(claims))
            .await
            .unwrap_err();
        assert_eq!(err.into_response().status(), StatusCode::FORBIDDEN);
    }
}
