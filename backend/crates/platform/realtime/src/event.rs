//! What the hub fans out.

use console_kernel_core::{BranchId, MessageId, ThreadId};
use console_messenger_application::MessageSummary;
use console_notifications_application::NotificationSummary;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RealtimeEvent {
    /// Account session consent, re-read at delivery after publication or reconnect.
    PrivacyConsent {
        accepted: bool,
    },
    MessagePosted {
        message: MessageSummary,
    },
    /// A message's ack count changed. Fanned out by branch scope + thread
    /// membership like `MessagePosted`, but carries only the ids + live count
    /// (no message body re-delivery). `branch_id`/`thread_id` drive fan-out;
    /// the client updates the count chip and never participates in replay.
    MessageAcked {
        message_id: MessageId,
        thread_id: ThreadId,
        branch_id: BranchId,
        ack_count: i64,
    },
    /// A notification created for a single recipient. Fanned out by recipient
    /// user id, not thread membership, and never participates in messenger
    /// replay — hence the messenger-only helpers below return `None` for it.
    NotificationCreated {
        notification: NotificationSummary,
    },
    /// Change stream (`contract.md`): sent once per stream after any replay;
    /// `id` is the tenant's head `seq`.
    Hello {
        id: String,
        data: HelloData,
    },
    /// One committed change (or a coalesced type) that passed the subscriber's
    /// read check. `id` is the `seq` cursor.
    Change {
        id: String,
        data: ChangeData,
    },
    /// The subscriber may have missed changes: invalidate active queries once.
    Reset {
        data: ResetData,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelloData {
    pub retry_ms: u64,
}

/// A change hint: ids and a version only, never actor, fields or values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangeData {
    #[serde(rename = "type")]
    pub resource_type: String,
    /// `None` = every id of the type (coalesced, or not the cached aggregate).
    pub id: Option<String>,
    pub ver: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub at: time::OffsetDateTime,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResetReason {
    /// The database listener reconnected; wakes may have been lost.
    Gap,
    /// The cursor is older than the replay window, or unknown.
    Pruned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResetData {
    pub reason: ResetReason,
}

impl RealtimeEvent {
    pub(crate) fn message_id(&self) -> Option<MessageId> {
        match self {
            Self::MessagePosted { message } => Some(message.id),
            _ => None,
        }
    }

    pub(crate) fn cursor(&self) -> Option<MessageCursor> {
        match self {
            Self::MessagePosted { message } => Some(MessageCursor {
                sent_at: message.sent_at,
                id: message.id,
            }),
            _ => None,
        }
    }

    pub(crate) fn branch_id(&self) -> Option<BranchId> {
        match self {
            Self::MessagePosted { message } => Some(message.branch_id),
            Self::MessageAcked { branch_id, .. } => Some(*branch_id),
            _ => None,
        }
    }

    pub(crate) fn thread_id(&self) -> Option<ThreadId> {
        match self {
            Self::MessagePosted { message } => Some(message.thread_id),
            Self::MessageAcked { thread_id, .. } => Some(*thread_id),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct MessageCursor {
    pub(crate) sent_at: time::OffsetDateTime,
    pub(crate) id: MessageId,
}
