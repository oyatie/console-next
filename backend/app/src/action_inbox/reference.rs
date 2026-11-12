// SPDX-License-Identifier: LicenseRef-Proprietary
//! Reference (`/api/v1/me/action-inbox/reference`): the notices addressed to the
//! caller, FYI and needing no action, newest first, and the Confirm action that marks
//! one read. Served through the notifications store with its own recipient
//! and mute rules; the notifications module's own routes stay off.
use axum::Extension;
use axum::Json;
use axum::extract::{Path, Query, State};
use console_kernel_core::{KernelError, NotificationId, TraceContext};
use console_notifications_adapter_postgres::PgNotificationStore;
use console_notifications_application::{
    ListNotificationsQuery, MarkNotificationReadCommand, NotificationPage, NotificationSummary,
};
use console_platform_authz::Principal;
use serde::Deserialize;
use time::OffsetDateTime;
use uuid::Uuid;

use super::{ActionInboxState, error::InboxError};

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ReferenceQuery {
    #[serde(default)]
    unread: bool,
    cursor: Option<Uuid>,
    limit: Option<i64>,
}

pub(super) async fn list(
    State(state): State<ActionInboxState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<ReferenceQuery>,
) -> Result<Json<NotificationPage>, InboxError> {
    let page = PgNotificationStore::new(state.pool)
        .list(ListNotificationsQuery {
            recipient: principal.user_id,
            unread_only: query.unread,
            before_id: query.cursor.map(NotificationId::from_uuid),
            limit: query.limit.unwrap_or(50),
        })
        .await
        .map_err(KernelError::from)?;
    Ok(Json(page))
}

/// Confirm: one of the caller's own notices, read. Another person's id is 404.
pub(super) async fn read(
    State(state): State<ActionInboxState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
) -> Result<Json<NotificationSummary>, InboxError> {
    let summary = PgNotificationStore::new(state.pool)
        .mark_read(MarkNotificationReadCommand {
            recipient: principal.user_id,
            notification_id: NotificationId::from_uuid(id),
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(KernelError::from)?;
    Ok(Json(summary))
}
