//! Shared error taxonomy. Domain crates define their own error enums and map
//! into these kinds at the application boundary; REST maps kinds to HTTP
//! status codes in exactly one place.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// Input failed validation (→ 422).
    Validation,
    /// Entity does not exist or is outside the caller's branch scope (→ 404).
    NotFound,
    /// Authenticated but not allowed (→ 403).
    Forbidden,
    /// State conflict, e.g. optimistic-lock or duplicate key (→ 409).
    Conflict,
    /// Illegal state-machine transition (→ 409 with transition detail).
    InvalidTransition,
    /// Service or resource temporarily unavailable (→ 503).
    Unavailable,
    /// Unexpected internal failure (→ 500; details logged, not returned).
    Internal,
}

impl ErrorKind {
    #[must_use]
    pub const fn status_code(&self) -> u16 {
        match self {
            Self::Validation => 422,
            Self::NotFound => 404,
            Self::Forbidden => 403,
            Self::Conflict | Self::InvalidTransition => 409,
            Self::Unavailable => 503,
            Self::Internal => 500,
        }
    }

    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Validation => "validation",
            Self::NotFound => "not_found",
            Self::Forbidden => "forbidden",
            Self::Conflict => "conflict",
            Self::InvalidTransition => "invalid_transition",
            Self::Unavailable => "unavailable",
            Self::Internal => "internal",
        }
    }
}

/// A refused response's OpenTelemetry `error.type` (its stable code), carried as a response extension: the HTTP
/// metrics label the request with it (`error_type`), so an SLI tells an expected refusal (`token_expired`: the
/// client renews and retries) from a fault. Static codes only, so the label stays bounded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ErrorType(pub &'static str);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, serde::Serialize, serde::Deserialize)]
#[error("{kind:?}: {message}")]
pub struct KernelError {
    pub kind: ErrorKind,
    pub message: String,
    /// Stable snake_case code (e.g. `exit_date_before_hire`). Not serialized,
    /// so the stored form stays byte-identical.
    #[serde(skip)]
    pub code: Option<&'static str>,
    /// Input the error points at (e.g. `slug`), for `errors[{field, code}]`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
}

impl KernelError {
    #[must_use]
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            code: None,
            field: None,
        }
    }

    #[must_use]
    pub fn with_code(mut self, code: &'static str) -> Self {
        self.code = Some(code);
        self
    }

    #[must_use]
    pub fn with_field(mut self, field: impl Into<String>) -> Self {
        self.field = Some(field.into());
        self
    }

    #[must_use]
    pub fn validation(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Validation, message)
    }

    #[must_use]
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::NotFound, message)
    }

    #[must_use]
    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Forbidden, message)
    }

    #[must_use]
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Conflict, message)
    }

    #[must_use]
    pub fn invalid_transition(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::InvalidTransition, message)
    }

    #[must_use]
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Unavailable, message)
    }

    #[must_use]
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Internal, message)
    }

    #[must_use]
    pub const fn status_code(&self) -> u16 {
        self.kind.status_code()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_includes_kind_and_message() {
        let err = KernelError::forbidden("cross-branch access denied");
        let text = err.to_string();
        assert!(text.contains("Forbidden"));
        assert!(text.contains("cross-branch access denied"));
    }

    #[test]
    fn kind_serializes_snake_case() {
        let json = serde_json::to_string(&ErrorKind::InvalidTransition).unwrap();
        assert_eq!(json, "\"invalid_transition\"");
    }

    #[test]
    fn code_and_field_are_additive() {
        let plain = KernelError::validation("bad slug");
        let json = r#"{"kind":"validation","message":"bad slug"}"#;
        assert_eq!(serde_json::to_string(&plain).unwrap(), json);
        assert_eq!(serde_json::from_str::<KernelError>(json).unwrap(), plain);

        let rich = plain.clone().with_code("slug_invalid").with_field("slug");
        assert_eq!(rich.to_string(), plain.to_string());
        assert_eq!(
            serde_json::to_string(&rich).unwrap(),
            r#"{"kind":"validation","message":"bad slug","field":"slug"}"#
        );
        assert_eq!(rich.code, Some("slug_invalid"));
    }

    #[test]
    fn kind_status_codes_match_http_taxonomy() {
        assert_eq!(ErrorKind::Validation.status_code(), 422);
        assert_eq!(ErrorKind::NotFound.status_code(), 404);
        assert_eq!(ErrorKind::Forbidden.status_code(), 403);
        assert_eq!(ErrorKind::Conflict.status_code(), 409);
        assert_eq!(ErrorKind::InvalidTransition.status_code(), 409);
        assert_eq!(ErrorKind::Unavailable.status_code(), 503);
        assert_eq!(ErrorKind::Internal.status_code(), 500);
        assert_eq!(ErrorKind::Unavailable.code(), "unavailable");
    }
}
