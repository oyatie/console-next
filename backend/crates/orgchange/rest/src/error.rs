use crate::*;

pub(crate) struct RestError {
    status: StatusCode,
    code: &'static str,
    message: String,
    /// Machine-readable reasons (`ErrorBody.error.reasons`), e.g. the blocker
    /// codes of a `preflight_blocked` refusal. Omitted when empty.
    reasons: Vec<String>,
}

impl RestError {
    pub(crate) fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            reasons: Vec::new(),
        }
    }

    pub(crate) fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", message)
    }

    /// A decisions #18 refusal answers with its own code (the console keys
    /// the message by it); every other error keeps its generic code.
    fn coded(mut self, code: Option<&'static str>) -> Self {
        if let Some(code) =
            code.filter(|c| ORG_STRUCTURE_CODES.contains(c) || ORG_CHANGE_CODES.contains(c))
        {
            self.code = code;
        }
        self
    }

    pub(crate) fn kernel(e: KernelError) -> Self {
        let code = e.code;
        let refusal = match e.kind {
            ErrorKind::Validation => {
                Self::new(StatusCode::UNPROCESSABLE_ENTITY, "validation", e.message)
            }
            ErrorKind::NotFound => Self::new(StatusCode::NOT_FOUND, "not_found", e.message),
            ErrorKind::Forbidden => Self::new(StatusCode::FORBIDDEN, "forbidden", e.message),
            ErrorKind::Conflict | ErrorKind::InvalidTransition => {
                Self::new(StatusCode::CONFLICT, "conflict", e.message)
            }
            ErrorKind::Unavailable => {
                Self::new(StatusCode::SERVICE_UNAVAILABLE, "unavailable", e.message)
            }
            ErrorKind::Internal => {
                Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", e.message)
            }
        };
        refusal.coded(code)
    }

    pub(crate) fn store(e: PgOrgChangeError) -> Self {
        let message = e.message();
        let code = match &e {
            PgOrgChangeError::Domain(k) => k.code,
            _ => None,
        };
        if let PgOrgChangeError::PreflightBlocked(codes) = e {
            let mut refusal = Self::new(StatusCode::CONFLICT, "preflight_blocked", message);
            refusal.reasons = codes;
            return refusal;
        }
        let refusal = match e.kind() {
            ErrorKind::Validation => {
                Self::new(StatusCode::UNPROCESSABLE_ENTITY, "validation", message)
            }
            ErrorKind::NotFound => Self::new(StatusCode::NOT_FOUND, "not_found", message),
            ErrorKind::Forbidden => Self::new(StatusCode::FORBIDDEN, "forbidden", message),
            ErrorKind::Conflict | ErrorKind::InvalidTransition => {
                Self::new(StatusCode::CONFLICT, "conflict", message)
            }
            ErrorKind::Unavailable => {
                Self::new(StatusCode::SERVICE_UNAVAILABLE, "unavailable", message)
            }
            ErrorKind::Internal => {
                Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", message)
            }
        };
        refusal.coded(code)
    }
}

impl IntoResponse for RestError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(if self.reasons.is_empty() {
                json!({"error":{"code":self.code,"message":self.message}})
            } else {
                json!({"error":{"code":self.code,"message":self.message,"reasons":self.reasons}})
            }),
        )
            .into_response()
    }
}
