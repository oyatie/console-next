//! The change stream on the hub: subscribe, replay after a `seq` cursor,
//! fan a woken transaction out. Transport-agnostic: `sse.rs` and `ws.rs`
//! both subscribe here and serialize the same `RealtimeEvent`s.

use std::sync::Arc;

use crate::ChangeReader;
use console_kernel_core::{MessageId, OrgId};
use time::OffsetDateTime;

use crate::event::{HelloData, ResetData, ResetReason};
use crate::filter::{ChangeRow, frames_for};
use crate::hub::ReplayPlan;
use crate::{
    PgRealtimeHub, REPLAY_PAGE_SIZE, RealtimeConnection, RealtimeError, RealtimeEvent,
    RealtimePrincipal, changes,
};

/// Where a stream resumes. Both cursors are optional; with neither the
/// stream opens live (after `hello`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StreamFrom {
    pub last_message_id: Option<MessageId>,
    pub last_event_id: Option<i64>,
}

impl PgRealtimeHub {
    /// A change-stream subscriber: messenger and notification frames as
    /// `connect` gives them, plus `hello`/`change`/`reset` filtered by
    /// `reader`. Without a database (crate tests) it opens live, without
    /// `hello` or replay.
    pub async fn connect_stream(
        self: &Arc<Self>,
        reader: impl Into<ChangeReader>,
        from: StreamFrom,
    ) -> RealtimeConnection {
        let reader = reader.into();
        let principal = RealtimePrincipal {
            user_id: reader.user_id(),
            branch_scope: reader.branch_scope(),
            org_id: reader.org_id(),
        };
        let plan = self.pool.is_some().then_some(ReplayPlan {
            last_message_id: from.last_message_id,
            change_stream: true,
            last_event_id: from.last_event_id,
        });
        self.register(principal, Some(Arc::new(reader)), plan).await
    }

    /// Replays changes after `cursor` (if any), then sends `hello` with the
    /// head `seq`. Runs inside the slot's replay task.
    pub(crate) async fn replay_changes(
        &self,
        connection_id: uuid::Uuid,
        principal: &RealtimePrincipal,
        cursor: Option<i64>,
    ) -> Result<(), RealtimeError> {
        let pool = self
            .pool
            .as_ref()
            .ok_or(RealtimeError::DatabaseNotConfigured)?;
        let org = principal.org_id;
        let Some(reader) = self.reader_of(connection_id).await else {
            return Ok(());
        };
        if let Some(cursor) = cursor {
            let overlap = self.config.replay_overlap;
            match changes::replay_start(pool, org, cursor, overlap).await? {
                None => {
                    let reset = RealtimeEvent::Reset {
                        data: ResetData {
                            reason: ResetReason::Pruned,
                        },
                    };
                    if !self.send_replay_event(connection_id, reset).await? {
                        return Ok(());
                    }
                }
                Some(start) => {
                    let mut after = (start, 0);
                    loop {
                        let page = changes::replay_page(pool, org, after, REPLAY_PAGE_SIZE).await?;
                        let Some((last_at, last)) = page.last() else {
                            break;
                        };
                        after = (*last_at, last.seq);
                        let full = page.len() >= usize::try_from(REPLAY_PAGE_SIZE).unwrap_or(0);
                        let rows: Vec<ChangeRow> = page.into_iter().map(|(_, row)| row).collect();
                        let now = OffsetDateTime::now_utc();
                        let threshold = self.config.coalesce_threshold;
                        for frame in frames_for(&reader, &rows, threshold, now) {
                            if !self.send_replay_event(connection_id, frame).await? {
                                return Ok(());
                            }
                        }
                        if !full {
                            break;
                        }
                    }
                }
            }
        }
        let head = changes::head_seq(pool, org).await?;
        let hello = RealtimeEvent::Hello {
            id: head.to_string(),
            data: HelloData {
                retry_ms: u64::try_from(self.config.retry_hint.as_millis()).unwrap_or(u64::MAX),
            },
        };
        self.send_replay_event(connection_id, hello).await?;
        Ok(())
    }

    /// Fans one woken transaction out to every change-stream slot of `org`,
    /// each filtered and coalesced under its own reader.
    pub(crate) async fn dispatch_changes(&self, org: OrgId, rows: &[ChangeRow]) {
        let readers: Vec<(uuid::Uuid, Arc<ChangeReader>)> = {
            let connections = self.connections.lock().await;
            connections
                .iter()
                .filter(|(_, slot)| slot.principal.org_id == org)
                .filter_map(|(id, slot)| Some((*id, Arc::clone(slot.reader.as_ref()?))))
                .collect()
        };
        let now = OffsetDateTime::now_utc();
        for (connection_id, reader) in readers {
            for frame in frames_for(&reader, rows, self.config.coalesce_threshold, now) {
                self.dispatch_to_connection(connection_id, frame, None)
                    .await;
            }
        }
    }

    /// `reset{gap}` to every change-stream slot: the listener reconnected and
    /// wakes may be lost. The client invalidates once.
    pub(crate) async fn reset_all(&self, reason: ResetReason) {
        let targets: Vec<uuid::Uuid> = {
            let connections = self.connections.lock().await;
            connections
                .iter()
                .filter(|(_, slot)| slot.reader.is_some())
                .map(|(id, _)| *id)
                .collect()
        };
        for connection_id in targets {
            let reset = RealtimeEvent::Reset {
                data: ResetData { reason },
            };
            self.dispatch_to_connection(connection_id, reset, None)
                .await;
        }
    }

    async fn reader_of(&self, connection_id: uuid::Uuid) -> Option<Arc<ChangeReader>> {
        let connections = self.connections.lock().await;
        connections.get(&connection_id)?.reader.clone()
    }
}
