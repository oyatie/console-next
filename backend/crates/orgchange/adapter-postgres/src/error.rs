use crate::*;

#[derive(Debug, thiserror::Error)]
pub enum PgOrgChangeError {
    #[error(transparent)]
    Db(#[from] DbError),
    #[error(transparent)]
    Domain(#[from] KernelError),
    /// §3.9.1 변경 동결 창: a live org mutation was refused because the period
    /// it takes effect in is closed. Distinct from `Domain` so the caller can
    /// record the refused attempt (`record_freeze_refusal`) before the 409
    /// leaves the store — the business transaction, and any audit row inside
    /// it, has already rolled back by then.
    #[error(transparent)]
    Frozen(KernelError),
    /// Submit refused because the in-transaction preflight found blockers.
    /// Carries the blocker codes so the caller can name them (409
    /// `preflight_blocked`), distinct from a generic state conflict.
    #[error("preflight blockers are present; resolve them and re-run preflight")]
    PreflightBlocked(Vec<String>),
}

impl From<sqlx::Error> for PgOrgChangeError {
    fn from(value: sqlx::Error) -> Self {
        Self::Db(DbError::Sqlx(value))
    }
}

impl PgOrgChangeError {
    #[must_use]
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::Domain(e) | Self::Frozen(e) => e.kind,
            Self::PreflightBlocked(_) => ErrorKind::Conflict,
            Self::Db(DbError::Sqlx(sqlx::Error::RowNotFound)) => ErrorKind::NotFound,
            Self::Db(DbError::Sqlx(sqlx::Error::Database(e)))
                // unique violation (idempotency/code race), CHECK violation
                // (gov_approvals self-approval), FK violation (referential net)
                if matches!(e.code().as_deref(), Some("23505" | "23514" | "23503")) =>
            {
                ErrorKind::Conflict
            }
            Self::Db(_) => ErrorKind::Internal,
        }
    }

    #[must_use]
    pub fn message(&self) -> String {
        match self {
            Self::Domain(e) | Self::Frozen(e) => e.message.clone(),
            Self::PreflightBlocked(_) => self.to_string(),
            Self::Db(DbError::Sqlx(sqlx::Error::Database(e))) => match e.code().as_deref() {
                Some("23514") => "기안자는 자신의 조직 개편을 승인할 수 없습니다.".to_owned(),
                Some("23505") => "a conflicting record already exists".to_owned(),
                Some("23503") => "a referenced record does not exist".to_owned(),
                _ => "internal server error".to_owned(),
            },
            Self::Db(_) => "internal server error".to_owned(),
        }
    }
}
