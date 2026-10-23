//! Realtime platform surface.
//!
//! PostgreSQL remains the source of truth. `LISTEN/NOTIFY` carries only IDs
//! and wakes the hub on every pod, which re-reads before fan-out. One hub, one
//! topic model and one read filter (`filter.rs`) sit behind both transports:
//! SSE (`sse`, one-way invalidations) and WebSocket (`ws`, two-way traffic).
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

mod auth;
mod changes;
mod consent;
mod deliver;
mod error;
mod event;
mod fanout;
mod filter;
mod hub;
mod listener;
mod messenger_sql;
mod notifier;
mod payload;
mod reader;
mod replay;
pub use reader::ChangeReader;
pub mod sse;
pub mod status;
mod stream;
mod ws;

use std::time::Duration;

pub use auth::{RealtimeRestState, TOKEN_EXPIRED};
pub use changes::RESOURCE_CHANGED_CHANNEL;
pub use error::{NotifyPayloadError, RealtimeError};
pub use event::{ChangeData, HelloData, RealtimeEvent, ResetData, ResetReason};
pub use hub::{
    DisconnectNotice, DisconnectReason, PgRealtimeHub, PostgresBridgeHandle, RealtimeConnection,
    RealtimeHubConfig, RealtimePrincipal,
};
pub use notifier::{PostgresMessageNotifier, PostgresNotificationNotifier};
pub use payload::{MessageAckNotifyPayload, MessageNotifyPayload, NotificationNotifyPayload};
pub use stream::StreamFrom;
pub use ws::router;

pub const MESSAGE_POSTED_CHANNEL: &str = "message_posted";
pub const MESSAGE_ACK_CHANNEL: &str = "message_ack";
pub const NOTIFICATION_CREATED_CHANNEL: &str = "notification_created";
pub const NOTIFY_PAYLOAD_LIMIT_BYTES: usize = 8000;
pub const DEFAULT_CONNECTION_BUFFER: usize = 64;
pub const REPLAY_PAGE_SIZE: i64 = 100;
pub const REPLAY_SEND_TIMEOUT: Duration = Duration::from_secs(30);
pub const WS_ROUTE_PATHS: &[&str] = &["/api/v1/ws"];
pub(crate) const SOCKET_IO_TIMEOUT: Duration = Duration::from_secs(5);
