//! Identity / org-setup REST API.
//!
//! Authenticated, authz-gated endpoints for the org-setup flow:
//!   * Users  — `/api/v1/users` (create/list/get/update/deactivate) and the
//!     self-profile pair `/api/v1/users/me`.
//!   * Regions — read-only applied-state listing at `/api/v1/regions`.
//!   * Branches — read-only applied-state list/detail; the list also backs
//!     support-ticket triage.
//!
//! The orgchange REST owner mounts the legacy region/branch mutation methods at
//! composition time. Those methods create governed proposals; identity itself
//! has no live org-structure write route.
//!
//! Authorization mirrors the IDOR-hardening in `issue_admin_otp`: creating or
//! newly promoting a user into EXECUTIVE/SUPER_ADMIN is restricted to
//! SUPER_ADMIN callers, and a sub-admin may only create or re-scope
//! non-privileged users in branches it controls (additions and removals).
//! Self-profile edits are open to every authenticated user.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

mod access_log;
mod openapi;
pub use openapi::OPENAPI_FRAGMENT;

mod authz;
mod cedar_shadow;
mod context;
mod directory;
mod error;
mod me;
mod metrics;
mod org;
mod policy;
mod rollout;
mod serde_util;
mod state;
mod users;

pub use cedar_shadow::{
    CEDAR_PBAC_SHADOW_AUDIT_ACTION, CEDAR_PBAC_SHADOW_ROLE_MANAGE_FLAG,
    authorize_org_manage_observed,
};
pub use directory::dto::VisibleDirectoryPerson;
pub use error::RestError;
pub use state::IdentityRestState;

use crate::directory::routes::list_directory_people;
use crate::me::routes::get_me;
use crate::me::routes::get_me_authz;
use crate::me::routes::update_me;
use crate::me::workspace::get_workspace;
use crate::me::workspace::put_workspace;
use crate::org::routes::get_branch;
use crate::org::routes::list_branches;
use crate::org::routes::list_regions;
use crate::policy::assignments::list_policy_assignments;
use crate::policy::assignments::replace_policy_assignments;
use crate::policy::preview::preview_policy_assignments;
use crate::policy::roles::create_policy_role;
use crate::policy::roles::update_policy_role;
use crate::policy::routes::list_policy_audit_events;
use crate::policy::routes::list_policy_features;
use crate::policy::routes::list_policy_role_templates;
use crate::policy::routes::list_policy_roles;
use crate::policy::status::preview_policy_role_status;
use crate::policy::status::update_policy_role_status;
use crate::rollout::flags::update_console_legacy_kill_switch;
use crate::rollout::flags::update_console_rollout_org_flag;
use crate::rollout::routes::get_console_rollout;
use crate::rollout::routes::update_console_rollout_opt_in;
use crate::users::lifecycle::activate_user;
use crate::users::lifecycle::deactivate_user;
use crate::users::routes::create_user;
use crate::users::routes::get_user;
use crate::users::routes::list_users;
use crate::users::routes::update_user;
use crate::users::sign_in_id::change_sign_in_id;
use crate::users::sign_in_id::sign_in_id_history;
use axum::Router;
use axum::routing::get;
use axum::routing::patch;
use axum::routing::post;
use axum::routing::put;

// ---------------------------------------------------------------------------
// Route paths (exported for the openapi_drift test)
// ---------------------------------------------------------------------------

pub const USERS_PATH: &str = "/api/v1/users";
/// Tenant people directory. Its router registration is intentionally private to
/// the identity service until app-router and OpenAPI consolidation lands.
pub const DIRECTORY_PEOPLE_PATH: &str = "/api/v1/directory/people";
pub const USERS_ME_PATH: &str = "/api/v1/users/me";
pub const CONSOLE_ROLLOUT_PATH: &str = "/api/v1/console/rollout";
pub const CONSOLE_ROLLOUT_OPT_IN_PATH: &str = "/api/v1/console/rollout/opt-in";
pub const CONSOLE_ROLLOUT_ORG_FLAG_PATH: &str = "/api/v1/console/rollout/org-flag";
pub const CONSOLE_LEGACY_KILL_SWITCH_PATH: &str = "/api/v1/console/kill-switch";
/// Per-(org,user) Oyatie Console workspace layout (UI-M1b). GET returns the
/// caller's saved layout (empty `{}` default), PUT upserts it. Opaque jsonb.
pub const ME_WORKSPACE_PATH: &str = "/api/v1/me/workspace";
/// Caller's authorization projection (Identity Console UI-M13 / charter G-a):
/// org, branch scope, roles-as-principal-attributes, and the legacy-matrix
/// capability grants the console needs for deny-by-omission rendering. NON-
/// AUTHORITATIVE (`authority = "advisory_ui_only"`) — the server stays the sole
/// enforcer; this is a rendering hint that converges with the Cedar promotion
/// (same shape, `source` flips from `legacy_matrix` to `cedar`).
pub const ME_AUTHZ_PATH: &str = "/api/v1/me/authz";
pub const USER_PATH_TEMPLATE: &str = "/api/v1/users/{id}";
pub const USER_DEACTIVATE_PATH_TEMPLATE: &str = "/api/v1/users/{id}/deactivate";
pub const USER_ACTIVATE_PATH_TEMPLATE: &str = "/api/v1/users/{id}/activate";
/// 아이디 변경 (decisions #33) and the account's 아이디 history.
pub const USER_SIGN_IN_ID_PATH_TEMPLATE: &str = "/api/v1/users/{id}/sign-in-id";
pub const USER_SIGN_IN_IDS_PATH_TEMPLATE: &str = "/api/v1/users/{id}/sign-in-ids";
pub const REGIONS_PATH: &str = "/api/v1/regions";
pub const REGION_PATH_TEMPLATE: &str = "/api/v1/regions/{id}";
pub const BRANCHES_PATH: &str = "/api/v1/branches";
pub const BRANCH_PATH_TEMPLATE: &str = "/api/v1/branches/{id}";
pub const POLICY_FEATURES_PATH: &str = "/api/v1/policy/features";
pub const POLICY_ROLES_PATH: &str = "/api/v1/policy/roles";
pub const POLICY_ROLE_PATH_TEMPLATE: &str = "/api/v1/policy/roles/{id}";
pub const POLICY_ROLE_STATUS_PATH_TEMPLATE: &str = "/api/v1/policy/roles/{id}/status";
pub const POLICY_ROLE_STATUS_PREVIEW_PATH_TEMPLATE: &str =
    "/api/v1/policy/roles/{id}/status-preview";
pub const POLICY_ROLE_TEMPLATES_PATH: &str = "/api/v1/policy/role-templates";
pub const POLICY_ASSIGNMENTS_PATH: &str = "/api/v1/policy/assignments";
pub const POLICY_USER_ASSIGNMENTS_PATH_TEMPLATE: &str = "/api/v1/policy/users/{id}/assignments";
pub const POLICY_USER_ASSIGNMENT_PREVIEW_PATH_TEMPLATE: &str =
    "/api/v1/policy/users/{id}/assignment-preview";
pub const POLICY_AUDIT_EVENTS_PATH: &str = "/api/v1/policy/audit-events";
pub const IDENTITY_ROUTE_PATHS: &[&str] = &[
    USERS_PATH,
    DIRECTORY_PEOPLE_PATH,
    USERS_ME_PATH,
    CONSOLE_ROLLOUT_PATH,
    CONSOLE_ROLLOUT_OPT_IN_PATH,
    CONSOLE_ROLLOUT_ORG_FLAG_PATH,
    CONSOLE_LEGACY_KILL_SWITCH_PATH,
    ME_WORKSPACE_PATH,
    ME_AUTHZ_PATH,
    USER_PATH_TEMPLATE,
    USER_DEACTIVATE_PATH_TEMPLATE,
    USER_ACTIVATE_PATH_TEMPLATE,
    USER_SIGN_IN_ID_PATH_TEMPLATE,
    USER_SIGN_IN_IDS_PATH_TEMPLATE,
    REGIONS_PATH,
    REGION_PATH_TEMPLATE,
    BRANCHES_PATH,
    BRANCH_PATH_TEMPLATE,
    POLICY_FEATURES_PATH,
    POLICY_ROLES_PATH,
    POLICY_ROLE_PATH_TEMPLATE,
    POLICY_ROLE_STATUS_PATH_TEMPLATE,
    POLICY_ROLE_STATUS_PREVIEW_PATH_TEMPLATE,
    POLICY_ROLE_TEMPLATES_PATH,
    POLICY_ASSIGNMENTS_PATH,
    POLICY_USER_ASSIGNMENTS_PATH_TEMPLATE,
    POLICY_USER_ASSIGNMENT_PREVIEW_PATH_TEMPLATE,
    POLICY_AUDIT_EVENTS_PATH,
];

pub fn router(state: IdentityRestState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let pool = state.pool().clone();
    let router = Router::new()
        // `/users/me` MUST be registered before `/users/{id}` so the literal
        // segment wins over the path capture.
        .route(USERS_ME_PATH, get(get_me).patch(update_me))
        .route(CONSOLE_ROLLOUT_PATH, get(get_console_rollout))
        .route(
            CONSOLE_ROLLOUT_OPT_IN_PATH,
            put(update_console_rollout_opt_in),
        )
        .route(
            CONSOLE_ROLLOUT_ORG_FLAG_PATH,
            put(update_console_rollout_org_flag),
        )
        .route(
            CONSOLE_LEGACY_KILL_SWITCH_PATH,
            post(update_console_legacy_kill_switch),
        )
        .route(ME_WORKSPACE_PATH, get(get_workspace).put(put_workspace))
        .route(ME_AUTHZ_PATH, get(get_me_authz))
        .route(USERS_PATH, get(list_users).post(create_user))
        .route(DIRECTORY_PEOPLE_PATH, get(list_directory_people))
        .route(USER_PATH_TEMPLATE, get(get_user).patch(update_user))
        .route(USER_DEACTIVATE_PATH_TEMPLATE, post(deactivate_user))
        .route(USER_ACTIVATE_PATH_TEMPLATE, post(activate_user))
        .route(USER_SIGN_IN_ID_PATH_TEMPLATE, post(change_sign_in_id))
        .route(USER_SIGN_IN_IDS_PATH_TEMPLATE, get(sign_in_id_history))
        .route(REGIONS_PATH, get(list_regions))
        .route(BRANCHES_PATH, get(list_branches))
        .route(BRANCH_PATH_TEMPLATE, get(get_branch))
        .route(POLICY_FEATURES_PATH, get(list_policy_features))
        .route(
            POLICY_ROLES_PATH,
            get(list_policy_roles).post(create_policy_role),
        )
        .route(POLICY_ROLE_PATH_TEMPLATE, patch(update_policy_role))
        .route(
            POLICY_ROLE_STATUS_PATH_TEMPLATE,
            patch(update_policy_role_status),
        )
        .route(
            POLICY_ROLE_STATUS_PREVIEW_PATH_TEMPLATE,
            post(preview_policy_role_status),
        )
        .route(POLICY_ROLE_TEMPLATES_PATH, get(list_policy_role_templates))
        .route(POLICY_AUDIT_EVENTS_PATH, get(list_policy_audit_events))
        .route(POLICY_ASSIGNMENTS_PATH, get(list_policy_assignments))
        .route(
            POLICY_USER_ASSIGNMENTS_PATH_TEMPLATE,
            put(replace_policy_assignments),
        )
        .route(
            POLICY_USER_ASSIGNMENT_PREVIEW_PATH_TEMPLATE,
            post(preview_policy_assignments),
        )
        .with_state(state);
    // Per-request tenant context: resolves the Principal and arms `CURRENT_ORG`
    // for every authenticated route on this router, so adapter reads/writes run
    // scoped to the request's tenant.
    console_platform_request_context::with_request_context(router, verifier, pool)
}
