use crate::context::request::bearer_token;
use crate::context::request::rest_error_from_request_context;
use crate::error::RestError;
use crate::state::AuthServices;
use axum::http::HeaderMap;
use console_kernel_core::OrgId;
use console_kernel_core::UserId;
use console_platform_auth::ActorSession;
use sqlx::PgPool;
use uuid::Uuid;

pub(crate) const GROUP_ADMIN_GROUP_ROLE: &str = "GROUP_ADMIN";
pub(crate) const GROUP_ADMIN_TENANT_ACTING_ROLE: &str = "GROUP_ADMIN_DELEGATED_ADMIN";

#[derive(Clone, Copy)]
pub(crate) struct AuthenticatedGroupAdminActor {
    pub(crate) id: UserId,
    /// Original source binding; minting must not renew its generations.
    pub(crate) session: ActorSession,
}

pub(crate) async fn authenticated_group_actor(
    pool: &PgPool,
    services: &AuthServices,
    headers: &HeaderMap,
) -> Result<AuthenticatedGroupAdminActor, RestError> {
    let token = bearer_token(headers)?;
    let claims = services
        .jwt_verifier
        .verify_access_token(token)
        .map_err(|_| RestError::unauthorized("invalid bearer token"))?;
    if claims.platform {
        return Err(RestError::forbidden(
            "platform tokens cannot use tenant group-admin endpoints",
        ));
    }
    if claims.view_as {
        return Err(RestError::forbidden(
            "read-only view-as tokens cannot manage group subsidiaries",
        ));
    }
    if claims.tenant_context.is_some() || claims.actor_session.is_some() {
        return Err(RestError::forbidden(
            "delegated tenant-context tokens cannot manage group subsidiaries",
        ));
    }
    if !has_group_admin_role_hint(&claims.group_roles) {
        return Err(RestError::forbidden("group admin role required"));
    }
    let home_org = Uuid::parse_str(&claims.org)
        .map(OrgId::from_uuid)
        .map_err(|_| RestError::unauthorized("invalid bearer token"))?;
    let (id, _) = console_platform_request_context::validate_current_claims(pool, &claims)
        .await
        .map_err(rest_error_from_request_context)?;
    Ok(AuthenticatedGroupAdminActor {
        id,
        session: ActorSession {
            family_id: claims
                .session_family_id
                .ok_or_else(|| RestError::unauthorized("missing session family"))?,
            expires_at: claims.exp,
            home_org,
            subject_version: claims.authz_subject_version,
            session_generation: claims.session_generation,
        },
    })
}

pub(crate) fn has_group_admin_role_hint(group_roles: &[String]) -> bool {
    group_roles
        .iter()
        .any(|role| role.as_str() == GROUP_ADMIN_GROUP_ROLE)
}
