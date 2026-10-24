// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{AccessClaims, JwtSettings, validate_group_roles, validate_tenant_context};
use crate::AuthError;
use console_kernel_core::OrgId;
use jsonwebtoken::{Algorithm, Validation, decode};
use std::str::FromStr;

pub(crate) fn verify_access_token(
    token: &str,
    decoding_key: &jsonwebtoken::DecodingKey,
    settings: &JwtSettings,
) -> Result<AccessClaims, AuthError> {
    verify_token(token, decoding_key, settings, false)
}

pub(crate) fn verify_support_token(
    token: &str,
    key: &jsonwebtoken::DecodingKey,
    settings: &JwtSettings,
) -> Result<AccessClaims, AuthError> {
    let claims = verify_token(token, key, settings, true)?;
    if claims.support.is_none() {
        return Err(AuthError::InvalidStoredData(
            "support token required".into(),
        ));
    }
    Ok(claims)
}

fn verify_token(
    token: &str,
    decoding_key: &jsonwebtoken::DecodingKey,
    settings: &JwtSettings,
    support_gate: bool,
) -> Result<AccessClaims, AuthError> {
    let mut validation = Validation::new(Algorithm::ES256);
    validation.leeway = 0;
    validation.set_issuer(&[settings.issuer.as_str()]);
    validation.set_audience(&[settings.audience.as_str()]);
    validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
    validation.validate_exp = !support_gate;
    validation.validate_nbf = true;
    let token = decode::<AccessClaims>(token, decoding_key, &validation)?;
    if !support_gate {
        token.claims.validate_expiry()?;
    }
    if token.claims.support.is_some()
        && (token.claims.platform
            || !token.claims.read_only
            || !token.claims.roles.is_empty()
            || token.claims.actor_session.is_none())
    {
        return Err(AuthError::InvalidStoredData(
            "support requires a read-only roleless operator binding".into(),
        ));
    }
    // Fail closed on a malformed tenant claim: the `org` claim arms
    // `app.current_org` for RLS, so a token whose `org` is not a valid UUID must
    // never be accepted — it could otherwise reach the DB with an unparseable or
    // empty tenant context.
    OrgId::from_str(&token.claims.org).map_err(|_| {
        AuthError::InvalidStoredData("token org claim is not a valid uuid".to_owned())
    })?;
    token.claims.access_scope()?;
    if token.claims.support.is_some() && !token.claims.group_roles.is_empty() {
        return Err(AuthError::InvalidStoredData(
            "support tokens cannot carry group roles".to_owned(),
        ));
    }
    validate_group_roles(&token.claims.group_roles)?;
    validate_tenant_context(
        token.claims.tenant_context,
        token.claims.group_context_id.as_deref(),
        token.claims.actor_home_org.as_deref(),
        &token.claims.roles,
        &token.claims.group_roles,
        token.claims.platform,
        token.claims.support.is_some(),
        token.claims.read_only,
    )?;
    Ok(token.claims)
}
