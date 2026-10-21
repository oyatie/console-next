//! The Postgres LISTEN/NOTIFY bridge: wake, re-read, fan out.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use console_kernel_core::{MessageId, NotificationId, OrgId, ThreadId};
use console_messenger_application::MessageSummary;
use console_notifications_application::NotificationSummary;
use console_platform_db::{DbError, with_org_conn};
use sqlx::postgres::PgListener;
use tokio::sync::watch;

use crate::changes::{self, ChangeWake, RESOURCE_CHANGED_CHANNEL};
use crate::event::ResetReason;
use crate::messenger_sql::{
    REALTIME_MESSAGE_GROUP_BY, message_select_builder, message_summary_from_row,
    notification_summary_from_row,
};
use crate::{
    MESSAGE_ACK_CHANNEL, MESSAGE_POSTED_CHANNEL, MessageAckNotifyPayload, MessageNotifyPayload,
    NOTIFICATION_CREATED_CHANNEL, NotificationNotifyPayload, NotifyPayloadError, PgRealtimeHub,
    PostgresBridgeHandle, RealtimeError, RealtimeEvent,
};

/// How often the listener prunes one tenant's `resource_changes`.
const PRUNE_EVERY: Duration = Duration::from_secs(60 * 60);

impl PgRealtimeHub {
    pub async fn start_postgres_listener(
        self: Arc<Self>,
    ) -> Result<PostgresBridgeHandle, RealtimeError> {
        let pool = self
            .pool
            .as_ref()
            .ok_or(RealtimeError::DatabaseNotConfigured)?
            .clone();
        let mut listener = PgListener::connect_with(&pool).await?;
        // One hub, one WS connection per user, both event streams: the same
        // listener carries messenger posts and notification-center events.
        listener.listen(MESSAGE_POSTED_CHANNEL).await?;
        listener.listen(MESSAGE_ACK_CHANNEL).await?;
        listener.listen(NOTIFICATION_CREATED_CHANNEL).await?;
        listener.listen(RESOURCE_CHANGED_CHANNEL).await?;
        let (ping_tx, mut ping_rx) =
            tokio::sync::mpsc::channel::<tokio::sync::oneshot::Sender<bool>>(1);
        *self.status_ping.lock().await = Some(ping_tx);
        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let hub = Arc::clone(&self);

        tokio::spawn(async move {
            let mut pruned: HashMap<OrgId, Instant> = HashMap::new();
            loop {
                let notification = tokio::select! {
                    Some(reply) = ping_rx.recv() => {
                        // Probe the actual LISTEN connection without publishing or reading tenant data.
                        let healthy = tokio::time::timeout(crate::SOCKET_IO_TIMEOUT,
                            sqlx::query("SELECT 1").execute(&mut listener)).await
                            .is_ok_and(|result| result.is_ok());
                        let _ = reply.send(healthy);
                        continue;
                    }
                    changed = shutdown_rx.changed() => {
                        if changed.is_err() || *shutdown_rx.borrow() {
                            break;
                        }
                        continue;
                    }
                    notification = listener.try_recv() => notification,
                };
                let notification = match notification {
                    Ok(Some(notification)) => notification,
                    // D1: the connection dropped and was re-established (and
                    // re-LISTENed) before `Ok(None)`; wakes in between are lost.
                    Ok(None) => {
                        tracing::warn!("Postgres realtime listener reconnected; sending reset");
                        hub.reset_all(ResetReason::Gap).await;
                        continue;
                    }
                    Err(err) => {
                        tracing::warn!(error = %err, "Postgres realtime listener failed; retrying");
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        continue;
                    }
                };
                let result = match notification.channel() {
                    MESSAGE_POSTED_CHANNEL => {
                        hub.handle_notify_payload(notification.payload()).await
                    }
                    MESSAGE_ACK_CHANNEL => hub.handle_ack_payload(notification.payload()).await,
                    NOTIFICATION_CREATED_CHANNEL => {
                        hub.handle_notification_payload(notification.payload())
                            .await
                    }
                    RESOURCE_CHANGED_CHANNEL => {
                        hub.handle_change_wake(&mut listener, &mut pruned, notification.payload())
                            .await
                    }
                    _ => Ok(()),
                };
                if let Err(err) = result {
                    tracing::warn!(error = %err, channel = notification.channel(), "failed to handle realtime notification");
                }
            }
        });

        Ok(PostgresBridgeHandle { shutdown_tx })
    }

    /// Re-reads the woken transaction on the listener's own connection and
    /// fans it out; prunes that tenant's expired rows at most hourly. A wake
    /// that names no rows (forged, or another tenant's) sends nothing.
    async fn handle_change_wake(
        &self,
        listener: &mut PgListener,
        pruned: &mut HashMap<OrgId, Instant>,
        payload: &str,
    ) -> Result<(), RealtimeError> {
        let wake: ChangeWake = serde_json::from_str(payload).map_err(NotifyPayloadError::from)?;
        let rows = changes::transaction_rows(listener, &wake).await?;
        self.dispatch_changes(wake.org, &rows).await;
        if pruned
            .get(&wake.org)
            .is_none_or(|at| at.elapsed() >= PRUNE_EVERY)
        {
            pruned.insert(wake.org, Instant::now());
            changes::prune(listener, wake.org, self.config.replay_window).await?;
        }
        Ok(())
    }

    async fn handle_notify_payload(&self, payload: &str) -> Result<(), RealtimeError> {
        let payload = MessageNotifyPayload::from_json_bytes(payload.as_bytes())?;
        // The listener has no request context; the org rides on the payload and
        // scopes every FORCE-RLS read triggered by this notification.
        let org = payload.org_id;
        let message = self
            .fetch_message(org, payload.message_id, payload.thread_id)
            .await?;
        self.dispatch_event(org, RealtimeEvent::MessagePosted { message }, None)
            .await
    }

    async fn handle_ack_payload(&self, payload: &str) -> Result<(), RealtimeError> {
        let payload = MessageAckNotifyPayload::from_json_bytes(payload.as_bytes())?;
        let org = payload.org_id;
        // Re-read the message under the publishing tenant to get the live
        // ack_count and its branch, then fan the count out by thread membership.
        let message = self
            .fetch_message(org, payload.message_id, payload.thread_id)
            .await?;
        self.dispatch_event(
            org,
            RealtimeEvent::MessageAcked {
                message_id: message.id,
                thread_id: message.thread_id,
                branch_id: message.branch_id,
                ack_count: message.ack_count,
            },
            None,
        )
        .await
    }

    async fn handle_notification_payload(&self, payload: &str) -> Result<(), RealtimeError> {
        let payload = NotificationNotifyPayload::from_json_bytes(payload.as_bytes())?;
        let notification = self
            .fetch_notification(payload.org_id, payload.notification_id)
            .await?;
        if notification.recipient_user_id != payload.recipient_user_id {
            return Err(RealtimeError::NotificationRecipientMismatch);
        }
        self.dispatch_notification(payload.org_id, notification)
            .await;
        Ok(())
    }

    pub(crate) async fn fetch_message(
        &self,
        org: OrgId,
        message_id: MessageId,
        thread_id: ThreadId,
    ) -> Result<MessageSummary, RealtimeError> {
        let pool = self
            .pool
            .as_ref()
            .ok_or(RealtimeError::DatabaseNotConfigured)?;
        let message_uuid = *message_id.as_uuid();
        let thread_uuid = *thread_id.as_uuid();
        // The org is carried from the NOTIFY payload; arm it so this read sees
        // the publishing tenant's FORCE-RLS rows.
        with_org_conn::<_, _, RealtimeError>(pool, org, move |tx| {
            Box::pin(async move {
                let mut builder = message_select_builder();
                builder.push(" WHERE m.id = ");
                builder.push_bind(message_uuid);
                builder.push(" AND m.thread_id = ");
                builder.push_bind(thread_uuid);
                builder.push(REALTIME_MESSAGE_GROUP_BY);
                let row = builder.build().fetch_one(tx.as_mut()).await?;
                message_summary_from_row(&row).map_err(|err| RealtimeError::Db(DbError::Sqlx(err)))
            })
        })
        .await
    }

    async fn fetch_notification(
        &self,
        org: OrgId,
        notification_id: NotificationId,
    ) -> Result<NotificationSummary, RealtimeError> {
        let pool = self
            .pool
            .as_ref()
            .ok_or(RealtimeError::DatabaseNotConfigured)?;
        let notification_uuid = *notification_id.as_uuid();
        with_org_conn::<_, _, RealtimeError>(pool, org, move |tx| {
            Box::pin(async move {
                let row = sqlx::query(
                    r#"
                    SELECT id, recipient_user_id, category, kind, body, link,
                           unread, created_at, read_at, resolved_at
                    FROM notifications
                    WHERE id = $1
                    "#,
                )
                .bind(notification_uuid)
                .fetch_one(tx.as_mut())
                .await?;
                notification_summary_from_row(&row)
                    .map_err(|err| RealtimeError::Db(DbError::Sqlx(err)))
            })
        })
        .await
    }
}
