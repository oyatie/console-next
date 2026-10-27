use time::Duration;

#[derive(Debug, Clone)]
pub struct AuthRestConfig {
    pub rp_id: String,
    pub rp_origin: String,
    pub rp_name: String,
    pub ceremony_ttl: Duration,
    pub jwt_issuer: String,
    pub jwt_audience: String,
    /// Access-token lifetime (15 minutes by default; a short override is accepted only in E2E stub mode).
    pub access_token_ttl: Duration,
    pub jwt_private_key_pem: String,
    pub jwt_public_key_pem: String,
    pub refresh_token_ttl: Duration,
    /// Absolute lifetime cap on a refresh-token family, measured from the
    /// family's creation. Past this ceiling a rotation is rejected and the family
    /// revoked, forcing a fresh primary authentication (NIST 800-63B AAL2).
    /// Sourced from `CONSOLE_REFRESH_FAMILY_ABSOLUTE_TTL_SECS` (default 24h).
    pub refresh_family_absolute_ttl: Duration,
    /// HTTPS deployment flag used by the composition root for SPA HSTS.
    /// Refresh cookies always carry Secure to satisfy the __Host- prefix.
    pub cookie_secure: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum AuthRestConfigError {
    #[error("invalid WebAuthn RP origin: {0}")]
    Url(#[from] url::ParseError),

    #[error("auth service configuration error: {0}")]
    Auth(#[from] console_platform_auth::AuthError),
}
