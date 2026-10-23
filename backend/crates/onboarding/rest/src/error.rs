//! Stable refusal envelopes at the HTTP boundary.
use super::*;
use serde_json::json;

pub(crate) struct RestError(
    pub(crate) StatusCode,
    pub(crate) &'static str,
    pub(crate) String,
    pub(crate) Vec<&'static str>,
    pub(crate) Option<&'static str>,
    pub(crate) Option<Box<serde_json::Value>>,
);

impl IntoResponse for RestError {
    fn into_response(self) -> Response {
        let mut error = json!({ "code": self.1, "message": self.2 });
        if !self.3.is_empty() {
            error["errors"] = json!(
                self.3
                    .iter()
                    .map(|f| json!({ "field": f, "code": "not_met" }))
                    .collect::<Vec<_>>()
            );
        }
        if let Some(remedy) = self.4 {
            error["reasons"] = json!([remedy]);
        }
        if let Some(details) = self.5 {
            error["details"] = *details;
        }
        (self.0, Json(json!({ "error": error }))).into_response()
    }
}

fn status(kind: ErrorKind) -> StatusCode {
    StatusCode::from_u16(kind.status_code()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
}

impl From<PgOnboardingError> for RestError {
    fn from(err: PgOnboardingError) -> Self {
        match err {
            PgOnboardingError::Refused {
                kind,
                code,
                fields,
                remedy,
                details,
            } => Self(status(kind), code, code.to_owned(), fields, remedy, details),
            PgOnboardingError::Db(e) if e.is_unavailable() => Self(
                StatusCode::SERVICE_UNAVAILABLE,
                "unavailable",
                "onboarding database unavailable".into(),
                vec![],
                None,
                None,
            ),
            PgOnboardingError::Db(e) => {
                tracing::error!(error = %e, "onboarding store error");
                Self(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal",
                    "internal server error".into(),
                    vec![],
                    None,
                    None,
                )
            }
        }
    }
}
