use crate::error::RestError;
use axum::http::StatusCode;
use console_platform_authz::Role;
use std::str::FromStr;

/// Remap the `401` that `load_user_auth_context_in_org` returns for a
/// missing/inactive user into a `403` for the admin issue-OTP path, where the CALLER is
/// authenticated and it is the requested TARGET that is invalid. Other statuses
/// (e.g. internal DB errors) pass through unchanged.
pub(crate) fn forbidden_if_unauthorized(err: RestError) -> RestError {
    if err.status == StatusCode::UNAUTHORIZED {
        RestError::forbidden("target user is not eligible for a sign-in code")
    } else {
        err
    }
}

/// Parse a target's stored role strings into [`Role`]s, rejecting unknown codes.
pub(crate) fn parse_roles(roles: &[String]) -> Result<Vec<Role>, RestError> {
    roles
        .iter()
        .map(|role| {
            Role::from_str(role).map_err(|_| RestError::internal("target has an unknown role"))
        })
        .collect()
}
