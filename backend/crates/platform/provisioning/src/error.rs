use console_kernel_core::KernelError;

#[derive(Debug, thiserror::Error)]
pub enum ProvisioningError {
    #[error("{0}")]
    OpsRecovery(&'static str),
    #[error("ops_recovery_hold_active")]
    OpsRecoveryHoldActive(Option<time::OffsetDateTime>),
    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),

    #[error("database helper error: {0}")]
    Db(#[from] console_platform_db::DbError),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("auth error: {0}")]
    Auth(#[from] console_platform_auth::AuthError),

    #[error("kernel error: {0}")]
    Kernel(#[from] KernelError),

    #[error("invalid roster: {0}")]
    InvalidRoster(String),

    #[error("unknown branch {region}/{branch} for roster phone {phone}")]
    UnknownBranch {
        phone: String,
        region: String,
        branch: String,
    },

    /// Generic OTP-redeem failure. Unknown, expired, revoked, and
    /// already-consumed all collapse to this single variant so the REST layer can
    /// surface one "invalid or expired" message without revealing which it was.
    #[error("invalid bootstrap credential")]
    InvalidBootstrapCredential,

    #[error("user already has a registered passkey")]
    UserAlreadyHasPasskey,

    #[error("user already has an active bootstrap credential")]
    ActiveBootstrapCredentialExists,

    #[error("not found: {0}")]
    NotFound(String),

    #[error("conflict: {0}")]
    Conflict(String),

    #[error("only the tenant ops account may request a company-domain change")]
    DomainRequestForbidden,

    /// Another tenant already uses the slug (UNIQUE `organizations.slug`).
    #[error("tenant slug is taken")]
    SlugTaken,

    /// The slug or name fails the `organizations` CHECKs.
    #[error("invalid tenant slug or name: {0}")]
    SlugInvalid(String),
}

/// Map a write to `organizations` (create or rename): 23505 → [`ProvisioningError::SlugTaken`],
/// 23514 → [`ProvisioningError::SlugInvalid`]; anything else stays a database fault.
pub(crate) fn map_org_write_error(err: sqlx::Error) -> ProvisioningError {
    match err.as_database_error().and_then(|db| db.code()).as_deref() {
        Some("23505") => ProvisioningError::SlugTaken,
        Some("23514") => ProvisioningError::SlugInvalid(
            "the slug is 3-40 lowercase letters, digits or hyphens, starting and ending with a letter or digit; the name is not empty".to_owned(),
        ),
        _ => ProvisioningError::Sqlx(err),
    }
}
