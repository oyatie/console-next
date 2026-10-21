//! The per-user open-stream count behind the 429.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use axum::http::StatusCode;
use console_kernel_core::{OrgId, UserId};
use console_platform_authz::Principal;

use super::SseState;
use crate::PgRealtimeHub;
use crate::auth::RealtimeApiError;

pub(super) type StreamCounts = Arc<Mutex<HashMap<(OrgId, UserId), usize>>>;

pub(super) struct Lease {
    streams: StreamCounts,
    key: (OrgId, UserId),
    hub: Arc<PgRealtimeHub>,
    pub(super) connection: Option<uuid::Uuid>,
}

impl Lease {
    /// Refuses one stream over the cap. Never evicts the oldest: two visible
    /// tabs would evict each other in a loop (spec F13).
    pub(super) fn acquire(state: &SseState, reader: &Principal) -> Result<Self, RealtimeApiError> {
        let key = (reader.org_id, reader.user_id);
        let mut streams = state.streams.lock().unwrap_or_else(PoisonError::into_inner);
        let open = streams.get(&key).copied().unwrap_or(0);
        if open >= state.config.max_streams_per_user {
            return Err(RealtimeApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "too_many_requests",
                "too many open event streams",
            ));
        }
        streams.insert(key, open + 1);
        Ok(Self {
            streams: Arc::clone(&state.streams),
            key,
            hub: Arc::clone(&state.rest.hub),
            connection: None,
        })
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        let mut streams = self.streams.lock().unwrap_or_else(PoisonError::into_inner);
        match streams.get(&self.key).copied() {
            Some(open) if open > 1 => {
                streams.insert(self.key, open - 1);
            }
            _ => {
                streams.remove(&self.key);
            }
        }
        drop(streams);
        // A body dropped by a gone client has no async tail to clean up in.
        if let (Some(id), Ok(runtime)) = (
            self.connection.take(),
            tokio::runtime::Handle::try_current(),
        ) {
            let hub = Arc::clone(&self.hub);
            runtime.spawn(async move { hub.remove_connection(id).await });
        }
    }
}
