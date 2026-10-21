//! `AppError`: the process-level error type.

use console_platform_db::DbError;
use console_platform_storage::StorageError;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("configuration error: {0}")]
    Config(String),
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("database unavailable: {0}")]
    DatabaseUnavailable(String),
    #[error("internal error: {0}")]
    Internal(String),
    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),
    #[error("storage error: {0}")]
    Storage(#[from] StorageError),
    #[error("telemetry error: {0}")]
    Telemetry(String),
    #[error("worker error: {0}")]
    Worker(String),
    #[error("realtime error: {0}")]
    Realtime(#[from] console_platform_realtime::RealtimeError),
}

impl From<DbError> for AppError {
    fn from(value: DbError) -> Self {
        match value {
            DbError::Unavailable(err) => Self::DatabaseUnavailable(err.to_string()),
            DbError::Sqlx(err) => Self::Database(err),
            DbError::Serialize(err) => Self::Internal(err.to_string()),
            DbError::CodeIssuance(err) => Self::Internal(err),
        }
    }
}
