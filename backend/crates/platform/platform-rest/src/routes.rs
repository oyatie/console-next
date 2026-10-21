//! Public route and method inventory for platform contract checks.
use crate::{
    PLATFORM_TENANT_CONTEXT_EXIT_PATH, PLATFORM_TENANT_CONTEXT_START_PATH,
    PLATFORM_VIEW_AS_EXIT_PATH, PLATFORM_VIEW_AS_START_PATH, TENANT_DOMAIN_REQUEST_PATH,
};

pub const PLATFORM_COMPANY_DOMAIN_PATH: &str = "/api/platform/company-domain";
pub const PLATFORM_ORGS_PATH: &str = "/api/platform/orgs";
pub const PLATFORM_ORG_PATH_TEMPLATE: &str = "/api/platform/orgs/{id}";
pub const PLATFORM_ORG_ADMIN_OTP_PATH_TEMPLATE: &str = "/api/platform/orgs/{id}/admin-otp";
pub const PLATFORM_GROUPS_PATH: &str = "/api/platform/groups";
pub const PLATFORM_GROUP_PATH_TEMPLATE: &str = "/api/platform/groups/{id}";
pub const PLATFORM_GROUP_ACCOUNTS_PATH_TEMPLATE: &str = "/api/platform/groups/{id}/accounts";
pub const PLATFORM_GROUP_ACCOUNT_ROLE_PATH_TEMPLATE: &str =
    "/api/platform/groups/{id}/accounts/{user_id}/roles/{group_role}";
pub const PLATFORM_GROUP_ORG_PATH_TEMPLATE: &str =
    "/api/platform/groups/{id}/organizations/{org_id}";
pub const PLATFORM_OPS_PATH: &str = "/api/platform/ops";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct PlatformRouteOperation {
    pub method: &'static str,
    pub path: &'static str,
}

pub const PLATFORM_ROUTE_PATHS: &[&str] = &[
    TENANT_DOMAIN_REQUEST_PATH,
    PLATFORM_COMPANY_DOMAIN_PATH,
    PLATFORM_ORGS_PATH,
    PLATFORM_ORG_PATH_TEMPLATE,
    PLATFORM_ORG_ADMIN_OTP_PATH_TEMPLATE,
    PLATFORM_GROUPS_PATH,
    PLATFORM_GROUP_PATH_TEMPLATE,
    PLATFORM_GROUP_ACCOUNTS_PATH_TEMPLATE,
    PLATFORM_GROUP_ACCOUNT_ROLE_PATH_TEMPLATE,
    PLATFORM_GROUP_ORG_PATH_TEMPLATE,
    PLATFORM_OPS_PATH,
    PLATFORM_VIEW_AS_START_PATH,
    PLATFORM_VIEW_AS_EXIT_PATH,
    PLATFORM_TENANT_CONTEXT_START_PATH,
    PLATFORM_TENANT_CONTEXT_EXIT_PATH,
];

/// Path+method inventory for the platform contract drift gate.
///
/// `PLATFORM_ROUTE_PATHS` keeps the legacy mounted-path coverage check green, but
/// it cannot detect a new method on an already-documented path. Keep this list in
/// lockstep with `router` and `view_as::routes`; `backend/app/tests/openapi_drift.rs`
/// fails CI when any `/api/platform/*` operation here is missing from OpenAPI.
pub const PLATFORM_ROUTE_OPERATIONS: &[PlatformRouteOperation] = &[
    PlatformRouteOperation {
        method: "GET",
        path: TENANT_DOMAIN_REQUEST_PATH,
    },
    PlatformRouteOperation {
        method: "POST",
        path: TENANT_DOMAIN_REQUEST_PATH,
    },
    PlatformRouteOperation {
        method: "GET",
        path: PLATFORM_COMPANY_DOMAIN_PATH,
    },
    PlatformRouteOperation {
        method: "GET",
        path: PLATFORM_ORGS_PATH,
    },
    PlatformRouteOperation {
        method: "POST",
        path: PLATFORM_ORGS_PATH,
    },
    PlatformRouteOperation {
        method: "PATCH",
        path: PLATFORM_ORG_PATH_TEMPLATE,
    },
    PlatformRouteOperation {
        method: "DELETE",
        path: PLATFORM_ORG_PATH_TEMPLATE,
    },
    PlatformRouteOperation {
        method: "POST",
        path: PLATFORM_ORG_ADMIN_OTP_PATH_TEMPLATE,
    },
    PlatformRouteOperation {
        method: "GET",
        path: PLATFORM_GROUPS_PATH,
    },
    PlatformRouteOperation {
        method: "POST",
        path: PLATFORM_GROUPS_PATH,
    },
    PlatformRouteOperation {
        method: "PATCH",
        path: PLATFORM_GROUP_PATH_TEMPLATE,
    },
    PlatformRouteOperation {
        method: "GET",
        path: PLATFORM_GROUP_ACCOUNTS_PATH_TEMPLATE,
    },
    PlatformRouteOperation {
        method: "POST",
        path: PLATFORM_GROUP_ACCOUNTS_PATH_TEMPLATE,
    },
    PlatformRouteOperation {
        method: "DELETE",
        path: PLATFORM_GROUP_ACCOUNT_ROLE_PATH_TEMPLATE,
    },
    PlatformRouteOperation {
        method: "PUT",
        path: PLATFORM_GROUP_ORG_PATH_TEMPLATE,
    },
    PlatformRouteOperation {
        method: "DELETE",
        path: PLATFORM_GROUP_ORG_PATH_TEMPLATE,
    },
    PlatformRouteOperation {
        method: "GET",
        path: PLATFORM_OPS_PATH,
    },
    PlatformRouteOperation {
        method: "POST",
        path: PLATFORM_VIEW_AS_START_PATH,
    },
    PlatformRouteOperation {
        method: "POST",
        path: PLATFORM_VIEW_AS_EXIT_PATH,
    },
    PlatformRouteOperation {
        method: "POST",
        path: PLATFORM_TENANT_CONTEXT_START_PATH,
    },
    PlatformRouteOperation {
        method: "POST",
        path: PLATFORM_TENANT_CONTEXT_EXIT_PATH,
    },
];
