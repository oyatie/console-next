//! Turning a queued hint into the frame a subscriber may see, for both
//! transports: messenger frames take the authorized re-read; change-stream
//! frames were filtered at dispatch with the slot's reader principal, which
//! is re-resolved once per `realtime.session_recheck_interval`.

use std::time::Duration;

use crate::ChangeReader;
use console_messenger_adapter_postgres::PgMessengerStore;
use console_messenger_application::MessageQuery;
use console_notifications_adapter_postgres::PgNotificationStore;
use console_notifications_application::NotificationQuery;
use console_platform_request_context::scope_org;
use tokio::time::Instant;

use crate::auth::{RealtimeApiError, principal_from_token, reader_from_token};
use crate::{RealtimeEvent, RealtimePrincipal, RealtimeRestState};

/// When the reader principal was last confirmed against the session.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Recheck {
    pub(crate) interval: Duration,
    pub(crate) checked_at: Instant,
}

impl Recheck {
    pub(crate) fn new(interval: Duration) -> Self {
        Self {
            interval,
            checked_at: Instant::now(),
        }
    }
}

/// The frame to send for `hint`, or an error that ends the stream. A reader
/// whose grants, scope or session changed ends it too: the reconnect replays
/// from the cursor under the new principal, so nothing is lost or leaked.
pub(crate) async fn prepare(
    state: &RealtimeRestState,
    token: &str,
    reader: &ChangeReader,
    recheck: &mut Recheck,
    hint: RealtimeEvent,
) -> Result<RealtimeEvent, RealtimeApiError> {
    if matches!(hint, RealtimeEvent::PrivacyConsent { .. }) {
        if reader_from_token(state, token).await? != *reader {
            return Err(RealtimeApiError::unauthorized("realtime access changed"));
        }
        let accepted = match crate::auth::require_consent(state, token).await {
            Ok(()) => true,
            Err(error)
                if error.status == axum::http::StatusCode::FORBIDDEN
                    && error.code == "privacy_consent_required" =>
            {
                false
            }
            Err(error) => return Err(error),
        };
        return Ok(RealtimeEvent::PrivacyConsent { accepted });
    }
    if !matches!(
        hint,
        RealtimeEvent::Hello { .. } | RealtimeEvent::Change { .. } | RealtimeEvent::Reset { .. }
    ) {
        let expected = RealtimePrincipal {
            user_id: reader.user_id(),
            branch_scope: reader.branch_scope(),
            org_id: reader.org_id(),
        };
        return materialize_event(state, token, &expected, hint).await;
    }
    if recheck.checked_at.elapsed() >= recheck.interval {
        if reader_from_token(state, token).await? != *reader {
            return Err(RealtimeApiError::unauthorized("realtime access changed"));
        }
        recheck.checked_at = Instant::now();
    }
    Ok(hint)
}

pub(crate) async fn materialize_event(
    state: &RealtimeRestState,
    token: &str,
    expected: &RealtimePrincipal,
    hint: RealtimeEvent,
) -> Result<RealtimeEvent, RealtimeApiError> {
    let principal = principal_from_token(state, token).await?;
    if principal.org_id != expected.org_id || principal.user_id != expected.user_id {
        return Err(RealtimeApiError::unauthorized("realtime access denied"));
    }
    let pool = state
        .hub
        .pool
        .as_ref()
        .ok_or_else(RealtimeApiError::unavailable)?;
    // The queue carries hints only. Each owner supplies the current authorized
    // projection; stale bodies, acknowledgment counts and links are never sent.
    let event = scope_org(principal.org_id, async {
        let (message_id, thread_id, posted) = match hint {
            RealtimeEvent::NotificationCreated { notification } => {
                if notification.recipient_user_id != principal.user_id {
                    return Err(RealtimeApiError::unauthorized("realtime access denied"));
                }
                let notification = PgNotificationStore::new(pool.clone())
                    .notification(NotificationQuery {
                        recipient: principal.user_id,
                        notification_id: notification.id,
                    })
                    .await
                    .map_err(|_| RealtimeApiError::unavailable())?
                    .ok_or_else(|| RealtimeApiError::unauthorized("realtime access denied"))?;
                return Ok(RealtimeEvent::NotificationCreated { notification });
            }
            RealtimeEvent::MessagePosted { message } => (message.id, message.thread_id, true),
            RealtimeEvent::MessageAcked {
                message_id,
                thread_id,
                ..
            } => (message_id, thread_id, false),
            change @ (RealtimeEvent::Hello { .. }
            | RealtimeEvent::Change { .. }
            | RealtimeEvent::Reset { .. }
            | RealtimeEvent::PrivacyConsent { .. }) => return Ok(change),
        };
        let message = PgMessengerStore::new(pool.clone())
            .message(MessageQuery {
                actor: principal.user_id,
                branch_scope: principal.branch_scope.clone(),
                message_id,
            })
            .await
            .map_err(|_| RealtimeApiError::unavailable())?
            .ok_or_else(|| RealtimeApiError::unauthorized("realtime access denied"))?;
        if message.thread_id != thread_id {
            return Err(RealtimeApiError::unauthorized("realtime access denied"));
        }
        Ok(if posted {
            RealtimeEvent::MessagePosted { message }
        } else {
            RealtimeEvent::MessageAcked {
                message_id: message.id,
                thread_id: message.thread_id,
                branch_id: message.branch_id,
                ack_count: message.ack_count,
            }
        })
    })
    .await?;
    let current = principal_from_token(state, token).await?;
    if current.org_id != principal.org_id
        || current.user_id != principal.user_id
        || event
            .branch_id()
            .is_some_and(|branch| !current.branch_scope.allows(branch))
    {
        return Err(RealtimeApiError::unauthorized("realtime access denied"));
    }
    Ok(event)
}
