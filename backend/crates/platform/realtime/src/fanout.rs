//! Messenger and notification fan-out to the live slots.

use std::collections::HashSet;

use console_kernel_core::{MessageId, OrgId, ThreadId, UserId};
use console_notifications_application::NotificationSummary;
use console_platform_db::with_org_conn;

use crate::hub::ConnectionDeliveryState;
use crate::{DisconnectNotice, DisconnectReason, PgRealtimeHub, RealtimeError, RealtimeEvent};

impl PgRealtimeHub {
    /// The canonical recipient and owning Company jointly identify targets;
    /// one account may hold connections in several delegated Company contexts.
    pub(crate) async fn dispatch_notification(
        &self,
        org: OrgId,
        notification: NotificationSummary,
    ) {
        let targets = {
            let connections = self.connections.lock().await;
            connections
                .iter()
                .filter(|(_, slot)| slot.principal.org_id == org)
                .filter(|(_, slot)| slot.principal.user_id == notification.recipient_user_id)
                .map(|(id, _)| *id)
                .collect::<Vec<_>>()
        };
        let event = RealtimeEvent::NotificationCreated { notification };
        for connection_id in targets {
            self.dispatch_to_connection(connection_id, event.clone(), None)
                .await;
        }
    }

    #[doc(hidden)]
    pub async fn dispatch_notification_for_test(
        &self,
        org: OrgId,
        notification: NotificationSummary,
    ) {
        self.dispatch_notification(org, notification).await;
    }

    pub(crate) async fn dispatch_event(
        &self,
        org: OrgId,
        event: RealtimeEvent,
        authorized_users: Option<HashSet<UserId>>,
    ) -> Result<(), RealtimeError> {
        // dispatch_event fans a MessagePosted out by branch scope + thread
        // membership; a NotificationCreated event has neither and is delivered
        // via dispatch_notification instead, so ignore it here.
        let (Some(branch_id), Some(thread_id)) = (event.branch_id(), event.thread_id()) else {
            return Ok(());
        };
        let candidate_users = if authorized_users.is_some() || self.pool.is_none() {
            authorized_users
        } else {
            let candidates = {
                let connections = self.connections.lock().await;
                connections
                    .values()
                    .filter(|slot| slot.principal.org_id == org)
                    .filter(|slot| slot.principal.branch_scope.allows(branch_id))
                    .map(|slot| slot.principal.user_id)
                    .collect::<Vec<_>>()
            };
            Some(
                self.authorized_thread_members(org, thread_id, candidates)
                    .await?,
            )
        };

        let targets = {
            let connections = self.connections.lock().await;
            connections
                .iter()
                .filter(|(_, slot)| slot.principal.org_id == org)
                .filter(|(_, slot)| slot.principal.branch_scope.allows(branch_id))
                .filter(|(_, slot)| {
                    candidate_users
                        .as_ref()
                        .is_none_or(|users| users.contains(&slot.principal.user_id))
                })
                .map(|(id, _)| *id)
                .collect::<Vec<_>>()
        };

        for connection_id in targets {
            self.dispatch_to_connection(connection_id, event.clone(), None)
                .await;
        }
        Ok(())
    }

    async fn authorized_thread_members(
        &self,
        org: OrgId,
        thread_id: ThreadId,
        candidates: Vec<UserId>,
    ) -> Result<HashSet<UserId>, RealtimeError> {
        let Some(pool) = &self.pool else {
            return Ok(candidates.into_iter().collect());
        };
        if candidates.is_empty() {
            return Ok(HashSet::new());
        }
        let candidate_ids = candidates
            .into_iter()
            .map(|user_id| *user_id.as_uuid())
            .collect::<Vec<_>>();
        let thread_uuid = *thread_id.as_uuid();
        // The org is carried from the NOTIFY payload; arm it so the membership
        // read sees the publishing tenant's FORCE-RLS rows.
        let rows: Vec<uuid::Uuid> = with_org_conn::<_, _, RealtimeError>(pool, org, move |tx| {
            Box::pin(async move {
                Ok(sqlx::query_scalar(
                    r#"
            SELECT user_id
            FROM messenger_thread_members
            WHERE thread_id = $1
              AND user_id = ANY($2)
            "#,
                )
                .bind(thread_uuid)
                .bind(candidate_ids)
                .fetch_all(tx.as_mut())
                .await?)
            })
        })
        .await?;

        Ok(rows.into_iter().map(UserId::from_uuid).collect())
    }

    pub(crate) async fn dispatch_to_connection(
        &self,
        connection_id: uuid::Uuid,
        event: RealtimeEvent,
        resume_after: Option<MessageId>,
    ) {
        let mut connections = self.connections.lock().await;
        let Some(slot) = connections.get_mut(&connection_id) else {
            return;
        };

        let mut disconnect_resume_after = None;
        match &mut slot.delivery_state {
            ConnectionDeliveryState::Live => {
                if slot.events_tx.try_send(event).is_err() {
                    disconnect_resume_after = Some(resume_after);
                }
            }
            ConnectionDeliveryState::Replaying {
                buffered_events,
                replay_cursor,
            } => {
                if buffered_events.len() >= self.config.connection_buffer.max(1) {
                    disconnect_resume_after =
                        Some(replay_cursor.map(|cursor| cursor.id).or(resume_after));
                } else {
                    buffered_events.push(event);
                }
            }
        }

        if let Some(resume_after) = disconnect_resume_after
            && let Some(slot) = connections.remove(&connection_id)
        {
            let _ = slot.disconnect_tx.send(DisconnectNotice {
                reason: DisconnectReason::LaggingConsumer,
                resume_after,
            });
        }
    }
}
