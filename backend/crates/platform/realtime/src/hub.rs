//! The hub: connection slots and per-connection delivery.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use console_kernel_core::{BranchScope, MessageId, OrgId, UserId};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use tokio::sync::{Mutex, mpsc, watch};

use console_platform_authz::Principal;

use crate::event::MessageCursor;
use crate::{DEFAULT_CONNECTION_BUFFER, RealtimeError, RealtimeEvent};

/// Hub tunables. Each field is the spec §9 key it names; INTEG fills them
/// from the settings registry (SET-RT), `Default` is the code default.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RealtimeHubConfig {
    /// `realtime.connection_buffer`
    pub connection_buffer: usize,
    /// `realtime.coalesce_threshold`: more surviving rows of one type in one
    /// transaction than this fold into one `id: null` frame.
    pub coalesce_threshold: usize,
    /// `realtime.replay_window`: rows older than this are pruned; a cursor
    /// older than this gets `reset{pruned}`.
    pub replay_window: Duration,
    /// `realtime.retry_hint`: the reconnect hint in `hello` and the SSE
    /// `retry:` field.
    pub retry_hint: Duration,
    /// Not a setting: the replay overlap, which must equal the app's
    /// `transaction_timeout` (startup invariant, INTEG).
    pub replay_overlap: Duration,
}

impl RealtimeHubConfig {
    /// The defaults with a `connection_buffer` of `n`.
    #[must_use]
    pub fn buffered(n: usize) -> Self {
        Self {
            connection_buffer: n,
            ..Self::default()
        }
    }
}

impl Default for RealtimeHubConfig {
    fn default() -> Self {
        Self {
            connection_buffer: DEFAULT_CONNECTION_BUFFER,
            coalesce_threshold: 50,
            replay_window: Duration::from_secs(24 * 60 * 60),
            retry_hint: Duration::from_secs(3),
            replay_overlap: Duration::from_secs(45),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RealtimePrincipal {
    pub user_id: UserId,
    pub branch_scope: BranchScope,
    /// The subscriber's tenant, taken from the authenticated WS session's JWT
    /// `org` claim. Replay reads run in a background task with no request
    /// context, so this org arms `app.current_org` for the subscriber's own
    /// FORCE-RLS reads.
    pub org_id: OrgId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DisconnectReason {
    LaggingConsumer,
    ReplayFailed,
    ServerShutdown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DisconnectNotice {
    pub reason: DisconnectReason,
    pub resume_after: Option<MessageId>,
}

#[derive(Debug)]
pub struct RealtimeConnection {
    id: uuid::Uuid,
    events_rx: mpsc::Receiver<RealtimeEvent>,
    disconnect_rx: mpsc::UnboundedReceiver<DisconnectNotice>,
}

impl RealtimeConnection {
    #[must_use]
    pub fn id(&self) -> uuid::Uuid {
        self.id
    }

    pub async fn recv(&mut self) -> Option<RealtimeEvent> {
        self.events_rx.recv().await
    }

    pub async fn disconnect(&mut self) -> Option<DisconnectNotice> {
        self.disconnect_rx.recv().await
    }

    pub(crate) fn into_parts(
        self,
    ) -> (
        uuid::Uuid,
        mpsc::Receiver<RealtimeEvent>,
        mpsc::UnboundedReceiver<DisconnectNotice>,
    ) {
        (self.id, self.events_rx, self.disconnect_rx)
    }
}

#[derive(Debug)]
pub(crate) struct ConnectionSlot {
    pub(crate) principal: RealtimePrincipal,
    pub(crate) events_tx: mpsc::Sender<RealtimeEvent>,
    pub(crate) disconnect_tx: mpsc::UnboundedSender<DisconnectNotice>,
    /// Set only on change-stream slots (`connect_stream`): the authorization
    /// principal the read filter decides with.
    pub(crate) reader: Option<Arc<Principal>>,
    pub(crate) delivery_state: ConnectionDeliveryState,
    pub(crate) replay_task: Option<tokio::task::AbortHandle>,
}

impl Drop for ConnectionSlot {
    fn drop(&mut self) {
        if let Some(task) = &self.replay_task {
            task.abort();
        }
    }
}

/// What a new slot replays before it goes live.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ReplayPlan {
    pub(crate) last_message_id: Option<MessageId>,
    /// A change-stream slot: replay changes after `last_event_id` (if any),
    /// then send `hello`.
    pub(crate) change_stream: bool,
    pub(crate) last_event_id: Option<i64>,
}

#[derive(Debug)]
pub(crate) enum ConnectionDeliveryState {
    Live,
    Replaying {
        buffered_events: Vec<RealtimeEvent>,
        replay_cursor: Option<MessageCursor>,
    },
}

#[derive(Debug)]
pub struct PgRealtimeHub {
    pub(crate) pool: Option<PgPool>,
    pub(crate) config: RealtimeHubConfig,
    pub(crate) connections: Mutex<HashMap<uuid::Uuid, ConnectionSlot>>,
    pub(crate) status_ping:
        Mutex<Option<tokio::sync::mpsc::Sender<tokio::sync::oneshot::Sender<bool>>>>,
}

impl PgRealtimeHub {
    #[must_use]
    pub fn new(pool: PgPool, config: RealtimeHubConfig) -> Self {
        Self {
            pool: Some(pool),
            config,
            connections: Mutex::new(HashMap::new()),
            status_ping: Mutex::new(None),
        }
    }

    #[must_use]
    pub fn for_tests(config: RealtimeHubConfig) -> Self {
        Self {
            pool: None,
            config,
            connections: Mutex::new(HashMap::new()),
            status_ping: Mutex::new(None),
        }
    }

    pub async fn connect(
        self: &Arc<Self>,
        principal: RealtimePrincipal,
        last_message_id: Option<MessageId>,
    ) -> Result<RealtimeConnection, RealtimeError> {
        if last_message_id.is_some() && self.pool.is_none() {
            return Err(RealtimeError::DatabaseNotConfigured);
        }
        let plan = last_message_id.map(|last_message_id| ReplayPlan {
            last_message_id: Some(last_message_id),
            change_stream: false,
            last_event_id: None,
        });
        Ok(self.register(principal, None, plan).await)
    }

    /// Registers a slot; with a plan it starts in `Replaying` (live events
    /// buffer) and a task replays, then flushes.
    pub(crate) async fn register(
        self: &Arc<Self>,
        principal: RealtimePrincipal,
        reader: Option<Arc<Principal>>,
        plan: Option<ReplayPlan>,
    ) -> RealtimeConnection {
        let capacity = self.config.connection_buffer.max(1);
        let (events_tx, events_rx) = mpsc::channel(capacity);
        let (disconnect_tx, disconnect_rx) = mpsc::unbounded_channel();
        let id = uuid::Uuid::new_v4();
        let delivery_state = if plan.is_some() {
            ConnectionDeliveryState::Replaying {
                buffered_events: Vec::new(),
                replay_cursor: None,
            }
        } else {
            ConnectionDeliveryState::Live
        };
        self.connections.lock().await.insert(
            id,
            ConnectionSlot {
                principal: principal.clone(),
                events_tx,
                disconnect_tx,
                reader,
                delivery_state,
                replay_task: None,
            },
        );

        if let Some(plan) = plan {
            let hub = Arc::clone(self);
            let task = tokio::spawn(async move {
                hub.run_replay(id, principal, plan).await;
            });
            // The producer or shutdown may remove the slot before installation.
            if let Some(slot) = self.connections.lock().await.get_mut(&id) {
                slot.replay_task = Some(task.abort_handle());
            } else {
                task.abort();
            }
        }

        RealtimeConnection {
            id,
            events_rx,
            disconnect_rx,
        }
    }

    pub async fn connection_count(&self) -> usize {
        self.connections.lock().await.len()
    }

    pub async fn remove_connection(&self, connection_id: uuid::Uuid) {
        self.connections.lock().await.remove(&connection_id);
    }

    pub async fn dispatch_local_for_test(
        &self,
        org: OrgId,
        event: RealtimeEvent,
    ) -> Result<(), RealtimeError> {
        self.dispatch_event(org, event, None).await
    }

    pub async fn shutdown(&self) {
        let mut connections = self.connections.lock().await;
        for (_, slot) in connections.drain() {
            let _ = slot.disconnect_tx.send(DisconnectNotice {
                reason: DisconnectReason::ServerShutdown,
                resume_after: None,
            });
        }
    }
}

#[derive(Debug, Clone)]
pub struct PostgresBridgeHandle {
    pub(crate) shutdown_tx: watch::Sender<bool>,
}

impl PostgresBridgeHandle {
    pub fn shutdown(&self) {
        let _ = self.shutdown_tx.send(true);
    }
}
