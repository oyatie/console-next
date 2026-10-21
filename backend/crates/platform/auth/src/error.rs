use thiserror::Error;

use crate::refresh::RefreshTokenUseError;

#[derive(Debug, Error)]
pub enum AuthError {
    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),

    #[error("database helper error: {0}")]
    Db(#[from] console_platform_db::DbError),

    #[error("json serialization error: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("jwt error: {0}")]
    Jwt(#[from] jsonwebtoken::errors::Error),

    #[error("webauthn error: {0:?}")]
    Webauthn(webauthn_rs::prelude::WebauthnError),

    #[error("kernel error: {0}")]
    Kernel(#[from] console_kernel_core::KernelError),

    #[error("refresh token use rejected: {0}")]
    Refresh(#[from] RefreshTokenUseError),

    /// The token's `kid` names no trusted key: retired by a rotation, or forged.
    #[error("token signing key is not trusted")]
    UnknownSigningKey,

    #[error("invalid stored auth data: {0}")]
    InvalidStoredData(String),
}

impl AuthError {
    /// A well-formed token whose `exp` has passed: an expected refusal (the client renews), not a forged one.
    #[must_use]
    pub fn is_expired(&self) -> bool {
        matches!(self, Self::Jwt(e) if *e.kind() == jsonwebtoken::errors::ErrorKind::ExpiredSignature)
    }
}

impl From<webauthn_rs::prelude::WebauthnError> for AuthError {
    fn from(value: webauthn_rs::prelude::WebauthnError) -> Self {
        Self::Webauthn(value)
    }
}
