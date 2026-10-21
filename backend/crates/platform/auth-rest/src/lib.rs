//! Auth REST API.
//!
//! This layer exposes the passkey ceremony and token-family primitives from
//! `console-platform-auth` over HTTP. It does not own ceremony or refresh storage;
//! those remain in the platform auth/provisioning crates.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

mod admin;
mod audit;
mod config;
mod consent;
mod context;
mod cookies;
#[cfg(feature = "dev-auth")]
mod dev_auth;
mod device_login;
mod dto;
mod enroll_handoff;
mod error;
mod group_admin;
mod limits;
mod otp;
mod passkey;
mod rate_limit;
mod signup;
mod state;
mod token;
mod urls;
mod util;

pub use config::{AuthRestConfig, AuthRestConfigError};
pub use rate_limit::prune_rate_limit_windows;
pub use state::AuthRestState;

use crate::admin::admin_credential_reset;
use crate::admin::issue_admin_otp;
use crate::consent::accept_privacy_consent;
use crate::consent::privacy_consent_status;
#[cfg(feature = "dev-auth")]
use crate::dev_auth::dev_auth_session;
use crate::device_login::approve::approve_device_login;
use crate::device_login::approve::approve_device_login_session;
use crate::device_login::poll::poll_device_login;
use crate::device_login::start::start_device_login;
use crate::enroll_handoff::enroll_handoff;
use crate::group_admin::routes::exit_group_admin_tenant_context;
use crate::group_admin::routes::list_group_admin_groups;
use crate::group_admin::routes::start_group_admin_tenant_context;
use crate::otp::redeem_otp;
use crate::passkey::login::finish_login;
use crate::passkey::login::start_login;
use crate::passkey::register::finish_registration;
use crate::passkey::register::start_registration;
use crate::passkey::self_service::delete_self_passkey;
use crate::passkey::self_service::list_self_passkeys;
use crate::passkey::step_up::start_mobile_step_up;
use crate::signup::signup;
use crate::token::logout::logout;
use crate::token::refresh::refresh_token;
use axum::Router;
use axum::routing::delete;
use axum::routing::get;
use axum::routing::post;

pub const SIGNUP_PATH: &str = "/api/v1/auth/signup";
pub const PASSKEY_REGISTER_START_PATH: &str = "/api/v1/auth/passkey/register/start";
pub const PASSKEY_REGISTER_FINISH_PATH: &str = "/api/v1/auth/passkey/register/finish";
pub const PASSKEY_LOGIN_START_PATH: &str = "/api/v1/auth/passkey/login/start";
pub const PASSKEY_LOGIN_FINISH_PATH: &str = "/api/v1/auth/passkey/login/finish";
pub const PASSKEY_STEP_UP_START_PATH: &str = "/api/v1/auth/passkey/step-up/start";
pub const OTP_REDEEM_PATH: &str = "/api/v1/auth/otp/redeem";
pub const ADMIN_OTP_ISSUE_PATH: &str = "/api/v1/auth/admin/otp/issue";
pub const ADMIN_CREDENTIAL_RESET_PATH: &str = "/api/v1/auth/admin/credential-reset";
pub const AUTH_PASSKEYS_PATH: &str = "/api/v1/auth/passkeys";
pub const AUTH_PASSKEY_PATH_TEMPLATE: &str = "/api/v1/auth/passkeys/{id}";
pub const PASSKEY_ENROLL_HANDOFF_PATH: &str = "/api/v1/auth/passkey/enroll-handoff";
pub const DEVICE_LOGIN_START_PATH: &str = "/api/v1/auth/device-login/start";
pub const DEVICE_LOGIN_POLL_PATH: &str = "/api/v1/auth/device-login/poll";
pub const DEVICE_LOGIN_APPROVE_PATH: &str = "/api/v1/auth/device-login/approve";
pub const DEVICE_LOGIN_APPROVE_SESSION_PATH: &str = "/api/v1/auth/device-login/approve-session";
pub const PRIVACY_CONSENT_STATUS_PATH: &str = "/api/v1/auth/privacy-consent/status";
pub const PRIVACY_CONSENT_ACCEPT_PATH: &str = "/api/v1/auth/privacy-consent/accept";
pub const TOKEN_REFRESH_PATH: &str = "/api/v1/auth/token/refresh";
pub const LOGOUT_PATH: &str = "/api/v1/auth/logout";
pub const GROUP_ADMIN_GROUPS_PATH: &str = "/api/v1/group-admin/groups";
pub const GROUP_ADMIN_TENANT_CONTEXT_PATH: &str = "/api/v1/group-admin/tenant-context";
pub const GROUP_ADMIN_TENANT_CONTEXT_EXIT_PATH: &str = "/api/v1/group-admin/tenant-context/exit";
/// Local-dev-only role-switch endpoint. The const itself only exists when the
/// `dev-auth` feature is compiled in — see the `dev_auth` module docs.
#[cfg(feature = "dev-auth")]
pub const DEV_AUTH_SESSION_PATH: &str = "/api/v1/dev-auth/session";
pub const AUTH_ROUTE_PATHS: &[&str] = &[
    SIGNUP_PATH,
    PASSKEY_REGISTER_START_PATH,
    PASSKEY_REGISTER_FINISH_PATH,
    PASSKEY_LOGIN_START_PATH,
    PASSKEY_LOGIN_FINISH_PATH,
    PASSKEY_STEP_UP_START_PATH,
    OTP_REDEEM_PATH,
    ADMIN_OTP_ISSUE_PATH,
    ADMIN_CREDENTIAL_RESET_PATH,
    AUTH_PASSKEYS_PATH,
    AUTH_PASSKEY_PATH_TEMPLATE,
    PASSKEY_ENROLL_HANDOFF_PATH,
    DEVICE_LOGIN_START_PATH,
    DEVICE_LOGIN_POLL_PATH,
    DEVICE_LOGIN_APPROVE_PATH,
    DEVICE_LOGIN_APPROVE_SESSION_PATH,
    PRIVACY_CONSENT_STATUS_PATH,
    PRIVACY_CONSENT_ACCEPT_PATH,
    TOKEN_REFRESH_PATH,
    LOGOUT_PATH,
    GROUP_ADMIN_GROUPS_PATH,
    GROUP_ADMIN_TENANT_CONTEXT_PATH,
    GROUP_ADMIN_TENANT_CONTEXT_EXIT_PATH,
];

/// The only routes an OTP enrollment session (`enrollment` claim) may reach:
/// read/accept the required privacy notice, register the first passkey (here,
/// or on another device through an enrollment handoff code), rotate its own
/// family, and sign out. Every other route answers 403
/// `passkey_required`; the SPA signs out and signs in with the new passkey
/// right after registration.
pub const ENROLLMENT_ROUTE_PATHS: &[&str] = &[
    PRIVACY_CONSENT_STATUS_PATH,
    PRIVACY_CONSENT_ACCEPT_PATH,
    PASSKEY_REGISTER_START_PATH,
    PASSKEY_REGISTER_FINISH_PATH,
    PASSKEY_ENROLL_HANDOFF_PATH,
    TOKEN_REFRESH_PATH,
    LOGOUT_PATH,
];

pub fn router(state: AuthRestState) -> Router {
    let router = Router::new()
        .route(SIGNUP_PATH, post(signup))
        .route(PASSKEY_REGISTER_START_PATH, post(start_registration))
        .route(PASSKEY_REGISTER_FINISH_PATH, post(finish_registration))
        .route(PASSKEY_LOGIN_START_PATH, post(start_login))
        .route(PASSKEY_LOGIN_FINISH_PATH, post(finish_login))
        .route(PASSKEY_STEP_UP_START_PATH, post(start_mobile_step_up))
        .route(OTP_REDEEM_PATH, post(redeem_otp))
        .route(ADMIN_OTP_ISSUE_PATH, post(issue_admin_otp))
        .route(ADMIN_CREDENTIAL_RESET_PATH, post(admin_credential_reset))
        .route(AUTH_PASSKEYS_PATH, get(list_self_passkeys))
        .route(AUTH_PASSKEY_PATH_TEMPLATE, delete(delete_self_passkey))
        .route(PASSKEY_ENROLL_HANDOFF_PATH, post(enroll_handoff))
        .route(DEVICE_LOGIN_START_PATH, post(start_device_login))
        .route(DEVICE_LOGIN_POLL_PATH, post(poll_device_login))
        .route(DEVICE_LOGIN_APPROVE_PATH, post(approve_device_login))
        .route(
            DEVICE_LOGIN_APPROVE_SESSION_PATH,
            post(approve_device_login_session),
        )
        .route(PRIVACY_CONSENT_STATUS_PATH, post(privacy_consent_status))
        .route(PRIVACY_CONSENT_ACCEPT_PATH, post(accept_privacy_consent))
        .route(TOKEN_REFRESH_PATH, post(refresh_token))
        .route(LOGOUT_PATH, post(logout))
        .route(GROUP_ADMIN_GROUPS_PATH, get(list_group_admin_groups))
        .route(
            GROUP_ADMIN_TENANT_CONTEXT_PATH,
            post(start_group_admin_tenant_context),
        )
        .route(
            GROUP_ADMIN_TENANT_CONTEXT_EXIT_PATH,
            post(exit_group_admin_tenant_context),
        );
    #[cfg(feature = "dev-auth")]
    let router = router.route(DEV_AUTH_SESSION_PATH, post(dev_auth_session));
    router.with_state(state)
}
