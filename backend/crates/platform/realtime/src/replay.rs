//! Messenger replay after a `last_message_id` cursor.

use std::collections::HashSet;
use std::sync::Arc;

use console_kernel_core::MessageId;
use console_messenger_adapter_postgres::PgMessengerStore;
use console_messenger_application::MessageQuery;
use console_platform_db::with_org_conn;
use console_platform_request_context::scope_org;

use crate::event::MessageCursor;
use crate::hub::{ConnectionDeliveryState, ReplayPlan};
use crate::messenger_sql::{
    REALTIME_MESSAGE_GROUP_BY, message_select_builder, message_summary_from_row, push_scope_filter,
};
use crate::{
    DisconnectNotice, DisconnectReason, PgRealtimeHub, REPLAY_PAGE_SIZE, REPLAY_SEND_TIMEOUT,
    RealtimeError, RealtimeEvent, RealtimePrincipal, SOCKET_IO_TIMEOUT,
};

impl PgRealtimeHub {
    pub(crate) async fn run_replay(
        self: Arc<Self>,
        connection_id: uuid::Uuid,
        principal: RealtimePrincipal,
        plan: ReplayPlan,
    ) {
        let result = async {
            if let Some(last_message_id) = plan.last_message_id {
                self.replay_after(connection_id, &principal, last_message_id)
                    .await?;
            }
            if plan.change_stream {
                self.replay_changes(connection_id, &principal, plan.last_event_id)
                    .await?;
            }
            self.finish_replay(connection_id).await
        }
        .await;

        if let Err(err) = result {
            tracing::warn!(error = %err, "realtime replay failed");
            let resume_after = self.replay_resume_after(connection_id).await;
            self.disconnect_connection(connection_id, DisconnectReason::ReplayFailed, resume_after)
                .await;
        }
    }

    async fn replay_after(
        &self,
        connection_id: uuid::Uuid,
        principal: &RealtimePrincipal,
        last_message_id: MessageId,
    ) -> Result<(), RealtimeError> {
        let pool = self
            .pool
            .as_ref()
            .ok_or(RealtimeError::DatabaseNotConfigured)?;
        // Replay runs in a spawned task with no request context, so the org is
        // carried from the authenticated subscriber session (`principal.org_id`)
        // and arms `app.current_org` for every FORCE-RLS read below.
        let org = principal.org_id;
        let store = PgMessengerStore::new(pool.clone());
        let cursor = tokio::time::timeout(
            SOCKET_IO_TIMEOUT,
            scope_org(
                org,
                store.message(MessageQuery {
                    actor: principal.user_id,
                    branch_scope: principal.branch_scope.clone(),
                    message_id: last_message_id,
                }),
            ),
        )
        .await
        .map_err(|_| RealtimeError::ReadTimedOut)??
        .ok_or(RealtimeError::CursorUnavailable)?;
        let mut cursor = MessageCursor {
            sent_at: cursor.sent_at,
            id: cursor.id,
        };

        loop {
            let cursor_sent_at = cursor.sent_at;
            let cursor_id = *cursor.id.as_uuid();
            let branch_scope = principal.branch_scope.clone();
            let user_uuid = *principal.user_id.as_uuid();
            let rows = tokio::time::timeout(
                SOCKET_IO_TIMEOUT,
                with_org_conn::<_, _, RealtimeError>(pool, org, move |tx| {
                    Box::pin(async move {
                        sqlx::query("SET LOCAL statement_timeout = '5s'")
                            .execute(tx.as_mut())
                            .await?;
                        let mut builder = message_select_builder();
                        builder.push(
                            r#"
                JOIN messenger_thread_members tm
                  ON tm.thread_id = m.thread_id
                 AND tm.user_id =
                "#,
                        );
                        builder.push_bind(user_uuid);
                        builder.push(" WHERE (m.sent_at, m.id) > (");
                        builder.push_bind(cursor_sent_at);
                        builder.push(", ");
                        builder.push_bind(cursor_id);
                        builder.push(")");
                        push_scope_filter(&mut builder, "m.branch_id", &branch_scope);
                        builder.push(REALTIME_MESSAGE_GROUP_BY);
                        builder.push(" ORDER BY m.sent_at ASC, m.id ASC LIMIT ");
                        builder.push_bind(REPLAY_PAGE_SIZE);
                        Ok(builder.build().fetch_all(tx.as_mut()).await?)
                    })
                }),
            )
            .await
            .map_err(|_| RealtimeError::ReadTimedOut)??;
            if rows.is_empty() {
                break;
            }

            let row_count = rows.len();
            for row in rows {
                let message = message_summary_from_row(&row)?;
                cursor = MessageCursor {
                    sent_at: message.sent_at,
                    id: message.id,
                };
                let event = RealtimeEvent::MessagePosted { message };
                if !self.send_replay_event(connection_id, event).await? {
                    return Ok(());
                }
            }

            if row_count < usize::try_from(REPLAY_PAGE_SIZE).unwrap_or(usize::MAX) {
                break;
            }
        }
        Ok(())
    }

    pub(crate) async fn send_replay_event(
        &self,
        connection_id: uuid::Uuid,
        event: RealtimeEvent,
    ) -> Result<bool, RealtimeError> {
        let cursor = event.cursor();
        let events_tx = {
            let connections = self.connections.lock().await;
            let Some(slot) = connections.get(&connection_id) else {
                return Ok(false);
            };
            slot.events_tx.clone()
        };

        match tokio::time::timeout(REPLAY_SEND_TIMEOUT, events_tx.send(event)).await {
            Ok(Ok(())) => {
                if let Some(cursor) = cursor {
                    self.mark_replay_cursor(connection_id, cursor).await;
                }
                Ok(true)
            }
            Ok(Err(_)) => {
                self.remove_connection(connection_id).await;
                Err(RealtimeError::ConnectionClosed)
            }
            Err(_) => {
                let resume_after = self.replay_resume_after(connection_id).await;
                self.disconnect_connection(
                    connection_id,
                    DisconnectReason::LaggingConsumer,
                    resume_after,
                )
                .await;
                Err(RealtimeError::ReplayTimedOut {
                    timeout: REPLAY_SEND_TIMEOUT,
                })
            }
        }
    }

    async fn finish_replay(&self, connection_id: uuid::Uuid) -> Result<(), RealtimeError> {
        loop {
            let events = {
                let mut connections = self.connections.lock().await;
                let Some(slot) = connections.get_mut(&connection_id) else {
                    return Ok(());
                };
                match &mut slot.delivery_state {
                    ConnectionDeliveryState::Live => return Ok(()),
                    ConnectionDeliveryState::Replaying {
                        buffered_events,
                        replay_cursor,
                    } => {
                        if buffered_events.is_empty() {
                            slot.delivery_state = ConnectionDeliveryState::Live;
                            return Ok(());
                        }
                        let replay_cursor = *replay_cursor;
                        let mut events = std::mem::take(buffered_events);
                        events.sort_by_key(RealtimeEvent::cursor);
                        let mut seen = HashSet::new();
                        events.retain(|event| {
                            let keep_by_cursor = match (event.cursor(), replay_cursor) {
                                // Notifications carry no messenger cursor: always deliver.
                                (None, _) | (Some(_), None) => true,
                                (Some(cursor), Some(replay_cursor)) => cursor > replay_cursor,
                            };
                            let keep_by_dedup = event.message_id().is_none_or(|id| seen.insert(id));
                            keep_by_cursor && keep_by_dedup
                        });
                        events
                    }
                }
            };

            for event in events {
                if !self.send_replay_event(connection_id, event).await? {
                    return Ok(());
                }
            }
        }
    }

    async fn mark_replay_cursor(&self, connection_id: uuid::Uuid, cursor: MessageCursor) {
        let mut connections = self.connections.lock().await;
        if let Some(slot) = connections.get_mut(&connection_id)
            && let ConnectionDeliveryState::Replaying { replay_cursor, .. } =
                &mut slot.delivery_state
        {
            *replay_cursor = Some(cursor);
        }
    }

    pub(crate) async fn replay_resume_after(&self, connection_id: uuid::Uuid) -> Option<MessageId> {
        let connections = self.connections.lock().await;
        connections
            .get(&connection_id)
            .and_then(|slot| match &slot.delivery_state {
                ConnectionDeliveryState::Live => None,
                ConnectionDeliveryState::Replaying { replay_cursor, .. } => {
                    replay_cursor.map(|cursor| cursor.id)
                }
            })
    }

    pub(crate) async fn disconnect_connection(
        &self,
        connection_id: uuid::Uuid,
        reason: DisconnectReason,
        resume_after: Option<MessageId>,
    ) {
        let mut connections = self.connections.lock().await;
        if let Some(slot) = connections.remove(&connection_id) {
            let _ = slot.disconnect_tx.send(DisconnectNotice {
                reason,
                resume_after,
            });
        }
    }
}
