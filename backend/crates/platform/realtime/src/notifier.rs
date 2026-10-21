//! Publishers: emit the NOTIFY after the row commits.

use console_messenger_application::{
    MessageAckNotification, MessageNotifier, MessageNotifyFuture, MessagePostedNotification,
};
use console_notifications_application::{
    NotificationCreatedNotification, NotificationNotifier, NotificationNotifyFuture,
};
use console_platform_request_context::current_org;
use sqlx::PgPool;

use crate::payload::validate_payload_size;
use crate::{
    MESSAGE_ACK_CHANNEL, MESSAGE_POSTED_CHANNEL, MessageAckNotifyPayload, MessageNotifyPayload,
    NOTIFICATION_CREATED_CHANNEL, NotificationNotifyPayload, NotifyPayloadError,
};

#[derive(Debug, Clone)]
pub struct PostgresMessageNotifier {
    pool: PgPool,
}

impl PostgresMessageNotifier {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn notify_message_posted(
        &self,
        notification: MessagePostedNotification,
    ) -> Result<(), NotifyPayloadError> {
        // The publisher runs inside the message-send request task, where the
        // tenant is armed, so `current_org()` resolves the org to stamp onto the
        // payload. The background listener has no request context and reads it
        // back to arm `app.current_org` before any FORCE-RLS table read.
        let org = current_org()?;
        let payload = MessageNotifyPayload::from_notification(notification, org).to_json_bytes()?;
        Self::validate_payload_size_for_test(&payload)?;
        let payload = String::from_utf8(payload).map_err(|err| {
            serde_json::Error::io(std::io::Error::new(std::io::ErrorKind::InvalidData, err))
        })?;

        sqlx::query("SELECT pg_notify($1, $2)")
            .bind(MESSAGE_POSTED_CHANNEL)
            .bind(payload)
            // rls-arming: ok pg_notify is not a tenant-table read
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub fn validate_payload_size_for_test(bytes: &[u8]) -> Result<(), NotifyPayloadError> {
        validate_payload_size(bytes)
    }
}

impl PostgresMessageNotifier {
    pub async fn notify_message_ack(
        &self,
        notification: MessageAckNotification,
    ) -> Result<(), NotifyPayloadError> {
        let org = current_org()?;
        let payload = MessageAckNotifyPayload {
            message_id: notification.message_id,
            thread_id: notification.thread_id,
            org_id: org,
        }
        .to_json_bytes()?;
        let payload = String::from_utf8(payload).map_err(|err| {
            serde_json::Error::io(std::io::Error::new(std::io::ErrorKind::InvalidData, err))
        })?;
        sqlx::query("SELECT pg_notify($1, $2)")
            .bind(MESSAGE_ACK_CHANNEL)
            .bind(payload)
            // rls-arming: ok pg_notify is not a tenant-table read
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}

impl MessageNotifier for PostgresMessageNotifier {
    fn message_posted(&self, notification: MessagePostedNotification) -> MessageNotifyFuture<'_> {
        Box::pin(async move {
            if let Err(err) = self.notify_message_posted(notification).await {
                tracing::error!(error = %err, "failed to publish messenger realtime notification");
            }
        })
    }

    fn message_ack_toggled(&self, notification: MessageAckNotification) -> MessageNotifyFuture<'_> {
        Box::pin(async move {
            if let Err(err) = self.notify_message_ack(notification).await {
                tracing::error!(error = %err, "failed to publish messenger ack realtime event");
            }
        })
    }
}

/// Publishes a `notification_created` NOTIFY after a notification row commits.
/// Runs inside the emitting request task where the tenant is armed, so
/// `current_org()` stamps the org onto the payload.
#[derive(Debug, Clone)]
pub struct PostgresNotificationNotifier {
    pool: PgPool,
}

impl PostgresNotificationNotifier {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn notify_notification_created(
        &self,
        notification: NotificationCreatedNotification,
    ) -> Result<(), NotifyPayloadError> {
        let org = current_org()?;
        let payload =
            NotificationNotifyPayload::from_notification(notification, org).to_json_bytes()?;
        let payload = String::from_utf8(payload).map_err(|err| {
            serde_json::Error::io(std::io::Error::new(std::io::ErrorKind::InvalidData, err))
        })?;
        sqlx::query("SELECT pg_notify($1, $2)")
            .bind(NOTIFICATION_CREATED_CHANNEL)
            .bind(payload)
            // rls-arming: ok pg_notify is not a tenant-table read
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}

impl NotificationNotifier for PostgresNotificationNotifier {
    fn notification_created(
        &self,
        notification: NotificationCreatedNotification,
    ) -> NotificationNotifyFuture<'_> {
        Box::pin(async move {
            if let Err(err) = self.notify_notification_created(notification).await {
                tracing::error!(error = %err, "failed to publish notification realtime event");
            }
        })
    }
}
