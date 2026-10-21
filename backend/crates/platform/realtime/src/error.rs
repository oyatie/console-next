//! Realtime error types.

use std::time::Duration;

use console_platform_db::DbError;
use console_platform_request_context::RequestContextError;

use console_messenger_adapter_postgres::PgMessengerError;

#[derive(Debug, thiserror::Error)]
pub enum NotifyPayloadError {
    #[error("NOTIFY payload is {size} bytes; it must be below {limit} bytes")]
    PayloadTooLarge { size: usize, limit: usize },

    #[error(transparent)]
    Serialize(#[from] serde_json::Error),

    #[error(transparent)]
    Database(#[from] sqlx::Error),

    #[error(transparent)]
    RequestContext(#[from] RequestContextError),
}

#[derive(Debug, thiserror::Error)]
pub enum RealtimeError {
    #[error("database is not configured for realtime")]
    DatabaseNotConfigured,

    #[error(transparent)]
    Database(#[from] sqlx::Error),

    #[error(transparent)]
    NotifyPayload(#[from] NotifyPayloadError),

    #[error(transparent)]
    Db(#[from] DbError),

    #[error(transparent)]
    RequestContext(#[from] RequestContextError),

    #[error("realtime connection closed during replay")]
    ConnectionClosed,

    #[error("realtime replay consumer did not drain within {timeout:?}")]
    ReplayTimedOut { timeout: Duration },

    #[error("notification wake recipient does not match the stored recipient")]
    NotificationRecipientMismatch,

    #[error(transparent)]
    Messenger(#[from] PgMessengerError),

    #[error("replay cursor is unavailable to this subscriber")]
    CursorUnavailable,

    #[error("realtime read timed out")]
    ReadTimedOut,
}
