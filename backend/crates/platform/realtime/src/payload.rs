//! LISTEN/NOTIFY payloads: ids plus the org, never bodies.

use console_kernel_core::{MessageId, NotificationId, OrgId, ThreadId, UserId};
use console_messenger_application::MessagePostedNotification;
use console_notifications_application::NotificationCreatedNotification;
use serde::{Deserialize, Serialize};

use crate::{NOTIFY_PAYLOAD_LIMIT_BYTES, NotifyPayloadError};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageNotifyPayload {
    pub message_id: MessageId,
    pub thread_id: ThreadId,
    /// The tenant that owns the posted message. Realtime is a background
    /// LISTEN/NOTIFY task with NO request context, so `current_org()` is not
    /// available in the listener; the publisher carries the org here so the
    /// listener can arm `app.current_org` before reading FORCE-RLS tables.
    pub org_id: OrgId,
}

impl MessageNotifyPayload {
    #[must_use]
    pub fn from_notification(notification: MessagePostedNotification, org_id: OrgId) -> Self {
        Self {
            message_id: notification.message_id,
            thread_id: notification.thread_id,
            org_id,
        }
    }

    pub fn to_json_bytes(&self) -> Result<Vec<u8>, NotifyPayloadError> {
        let bytes = serde_json::to_vec(self)?;
        validate_payload_size(&bytes)?;
        Ok(bytes)
    }

    pub fn from_json_bytes(bytes: &[u8]) -> Result<Self, NotifyPayloadError> {
        validate_payload_size(bytes)?;
        Ok(serde_json::from_slice(bytes)?)
    }
}

/// LISTEN/NOTIFY payload for an ack-count change — IDs + org only, matching
/// [`MessageNotifyPayload`]; the listener re-reads the live count before fan-out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageAckNotifyPayload {
    pub message_id: MessageId,
    pub thread_id: ThreadId,
    pub org_id: OrgId,
}

impl MessageAckNotifyPayload {
    pub fn to_json_bytes(&self) -> Result<Vec<u8>, NotifyPayloadError> {
        let bytes = serde_json::to_vec(self)?;
        validate_payload_size(&bytes)?;
        Ok(bytes)
    }

    pub fn from_json_bytes(bytes: &[u8]) -> Result<Self, NotifyPayloadError> {
        validate_payload_size(bytes)?;
        Ok(serde_json::from_slice(bytes)?)
    }
}

/// LISTEN/NOTIFY payload for a created notification — IDs only, plus the org so
/// the listener (no request context) can arm `app.current_org` before reading
/// the FORCE-RLS `notifications` row. Mirrors [`MessageNotifyPayload`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NotificationNotifyPayload {
    pub notification_id: NotificationId,
    pub recipient_user_id: UserId,
    pub org_id: OrgId,
}

impl NotificationNotifyPayload {
    #[must_use]
    pub fn from_notification(notification: NotificationCreatedNotification, org_id: OrgId) -> Self {
        Self {
            notification_id: notification.notification_id,
            recipient_user_id: notification.recipient_user_id,
            org_id,
        }
    }

    pub fn to_json_bytes(&self) -> Result<Vec<u8>, NotifyPayloadError> {
        let bytes = serde_json::to_vec(self)?;
        validate_payload_size(&bytes)?;
        Ok(bytes)
    }

    pub fn from_json_bytes(bytes: &[u8]) -> Result<Self, NotifyPayloadError> {
        validate_payload_size(bytes)?;
        Ok(serde_json::from_slice(bytes)?)
    }
}

pub(crate) fn validate_payload_size(bytes: &[u8]) -> Result<(), NotifyPayloadError> {
    if bytes.len() >= NOTIFY_PAYLOAD_LIMIT_BYTES {
        Err(NotifyPayloadError::PayloadTooLarge {
            size: bytes.len(),
            limit: NOTIFY_PAYLOAD_LIMIT_BYTES,
        })
    } else {
        Ok(())
    }
}
