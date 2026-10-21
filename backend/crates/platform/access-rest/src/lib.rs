//! Tenant roles, grants and effective access — the REST face of the pilot
//! roles slice (decision #26; access-model AX-6 subset). Contract:
//! the identity face (`crates/identity/rest/openapi/**/access*`). The use cases and every check live in
//! `console-platform-access`; this crate only maps HTTP.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

mod catalog;
mod error;
mod handlers;

use axum::Router;
use axum::routing::{get, post};
use console_platform_access::AccessService;
use console_platform_auth::JwtVerifier;

pub const ACCESS_CATALOG_PATH: &str = "/api/v1/access/catalog";
pub const ACCESS_ROLES_PATH: &str = "/api/v1/access/roles";
pub const ACCESS_ROLE_PATH: &str = "/api/v1/access/roles/{roleId}";
pub const ACCESS_ROLE_STATUS_PATH: &str = "/api/v1/access/roles/{roleId}/status";
pub const ACCESS_ROLE_VERSIONS_PATH: &str = "/api/v1/access/roles/{roleId}/versions";
pub const ACCESS_GRANTS_PATH: &str = "/api/v1/access/grants";
pub const ACCESS_GRANTS_PREVIEW_PATH: &str = "/api/v1/access/grants/preview";
pub const ACCESS_GRANTS_APPLY_PATH: &str = "/api/v1/access/grants/apply";
pub const ACCESS_GRANT_NOTICE_PATH: &str = "/api/v1/access/grants/{grantId}/notice";
pub const ACCESS_ACCOUNT_EFFECTIVE_PATH: &str = "/api/v1/access/accounts/{accountId}/effective";
pub const ACCESS_ME_PATH: &str = "/api/v1/access/me";
pub const ACCESS_OPS_PATH: &str = "/api/v1/access/ops";
pub const ACCESS_OPS_USAGE_PATH: &str = "/api/v1/access/ops-usage";
pub const ACCESS_REQUESTS_PATH: &str = "/api/v1/access/requests";
pub const ACCESS_REQUEST_CLOSE_PATH: &str = "/api/v1/access/requests/{requestId}/close";
pub const ACCESS_GRANTERS_PATH: &str = "/api/v1/access/granters";

/// Every route this face serves (the app's surface registry).
pub const ACCESS_ROUTE_PATHS: &[&str] = &[
    ACCESS_CATALOG_PATH,
    ACCESS_ROLES_PATH,
    ACCESS_ROLE_PATH,
    ACCESS_ROLE_STATUS_PATH,
    ACCESS_ROLE_VERSIONS_PATH,
    ACCESS_GRANTS_PATH,
    ACCESS_GRANTS_PREVIEW_PATH,
    ACCESS_GRANTS_APPLY_PATH,
    ACCESS_GRANT_NOTICE_PATH,
    ACCESS_ACCOUNT_EFFECTIVE_PATH,
    ACCESS_ME_PATH,
    ACCESS_OPS_PATH,
    ACCESS_OPS_USAGE_PATH,
    ACCESS_REQUESTS_PATH,
    ACCESS_REQUEST_CLOSE_PATH,
    ACCESS_GRANTERS_PATH,
];

#[derive(Clone)]
pub struct AccessRestState {
    service: AccessService,
    jwt_verifier: Option<JwtVerifier>,
}

impl AccessRestState {
    #[must_use]
    pub const fn new(service: AccessService, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self {
            service,
            jwt_verifier,
        }
    }
}

/// The face's router; it applies the request context itself.
pub fn router(state: AccessRestState) -> Router {
    use handlers as h;
    let verifier = state.jwt_verifier.clone();
    let pool = state.service.pool().clone();
    let router = Router::new()
        .route(ACCESS_CATALOG_PATH, get(catalog::get_catalog))
        .route(ACCESS_ROLES_PATH, get(h::list_roles).post(h::create_role))
        .route(
            ACCESS_ROLE_PATH,
            get(h::get_role)
                .patch(h::update_role)
                .delete(h::delete_role),
        )
        .route(ACCESS_ROLE_STATUS_PATH, post(h::set_role_status))
        .route(ACCESS_ROLE_VERSIONS_PATH, get(h::role_versions))
        .route(ACCESS_GRANTS_PATH, get(h::list_grants))
        .route(ACCESS_GRANTS_PREVIEW_PATH, post(h::preview_grants))
        .route(ACCESS_GRANTS_APPLY_PATH, post(h::apply_grants))
        .route(ACCESS_GRANT_NOTICE_PATH, post(h::confirm_grant_notice))
        .route(ACCESS_ACCOUNT_EFFECTIVE_PATH, get(h::account_effective))
        .route(ACCESS_ME_PATH, get(h::my_effective))
        .route(ACCESS_OPS_PATH, get(h::ops_account))
        .route(ACCESS_OPS_USAGE_PATH, get(h::ops_usage))
        .route(
            ACCESS_REQUESTS_PATH,
            get(h::list_requests).post(h::create_request),
        )
        .route(ACCESS_REQUEST_CLOSE_PATH, post(h::close_request))
        .route(ACCESS_GRANTERS_PATH, get(h::granters))
        .with_state(state);
    console_platform_request_context::with_request_context(router, verifier, pool)
}
