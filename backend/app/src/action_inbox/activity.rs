// SPDX-License-Identifier: LicenseRef-Proprietary
//! 활동 내역 (`/api/v1/me/action-inbox/items/{id}/activity`): what happened to
//! one of my inbox items' subjects, newest first. The item is resolved through
//! my own sources (the same read as the list), so someone else's item, an
//! unknown one and a malformed id answer one 404. Rows carry who, what and
//! when only, never the audit snapshots.
use axum::Extension;
use axum::Json;
use axum::extract::{Path, Query, State};
use console_kernel_core::KernelError;
use console_platform_authz::Principal;
use serde::Serialize;
use time::OffsetDateTime;

use super::{ActionInboxState, error::InboxError};

const LIMIT: i64 = 50;
/// At 200 items a page, an item further than 2 000 rows down is treated as not found.
const MAX_PAGES: usize = 10;
/// Verbs the browser labels; any other action code reads as `other`.
const VERBS: [&str; 10] = [
    "create", "submit", "approve", "reject", "decide", "apply", "withdraw", "cancel", "update",
    "confirm",
];

#[derive(Debug, Serialize)]
pub(super) struct Activity {
    verb: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    actor_name: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    occurred_at: OffsetDateTime,
}

#[derive(Debug, Serialize)]
pub(super) struct ActivityPage {
    items: Vec<Activity>,
}

fn verb(action: &str) -> &'static str {
    let last = action.rsplit('.').next().unwrap_or_default();
    VERBS
        .into_iter()
        .find(|verb| *verb == last)
        .unwrap_or("other")
}

/// The item's own id and its subject's id, when the item is in my inbox now. Pages through the same read as
/// the list (every source and its authorization), stopping at the item or after a bounded scan.
async fn resolve(
    state: &ActionInboxState,
    principal: &Principal,
    id: &str,
) -> Result<Option<Vec<String>>, InboxError> {
    let mut cursor = None;
    for _ in 0..MAX_PAGES {
        let Json(page) = super::list_action_inbox(
            State(state.clone()),
            Extension(principal.clone()),
            Query(super::ActionInboxQuery {
                limit: Some(200),
                cursor,
                ..Default::default()
            }),
        )
        .await?;
        if let Some(item) = page["items"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|item| item["id"] == id)
        {
            let own = id.rsplit_once(':').map(|(_, uuid)| uuid.to_owned());
            let subject = item["links"][0]["id"].as_str().map(str::to_owned);
            return Ok(Some(own.into_iter().chain(subject).collect()));
        }
        match page["next_cursor"].as_str() {
            Some(next) => cursor = Some(next.to_owned()),
            None => return Ok(None),
        }
    }
    Ok(None)
}

fn not_found() -> InboxError {
    KernelError::not_found("no such inbox item")
        .with_code("inbox_item_not_found")
        .into()
}

pub(super) async fn list(
    State(state): State<ActionInboxState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> Result<Json<ActivityPage>, InboxError> {
    let subjects = resolve(&state, &principal, &id)
        .await?
        .ok_or_else(not_found)?;
    let org = principal.org_id;
    let rows: Vec<(String, OffsetDateTime, Option<String>)> =
        console_platform_db::with_org_conn::<_, _, console_platform_db::DbError>(
            &state.pool,
            org,
            move |tx| {
                Box::pin(async move {
                    Ok(sqlx::query_as(
                        "SELECT a.action, a.occurred_at, p.display_name FROM audit_events a \
                         LEFT JOIN person_accounts_current p ON p.org_id = a.org_id AND p.id = a.actor \
                         WHERE a.org_id = $1 AND a.target_id = ANY($2) \
                         ORDER BY a.occurred_at DESC, a.id DESC LIMIT $3",
                    )
                    .bind(org.as_uuid())
                    .bind(&subjects)
                    .bind(LIMIT)
                    .fetch_all(tx.as_mut())
                    .await?)
                })
            },
        )
        .await
        .map_err(|error| KernelError::internal(format!("activity read: {error:?}")))?;
    Ok(Json(ActivityPage {
        items: rows
            .into_iter()
            .map(|(action, occurred_at, actor_name)| Activity {
                verb: verb(&action),
                actor_name,
                occurred_at,
            })
            .collect(),
    }))
}

#[cfg(test)]
mod tests {
    #[test]
    fn verbs_are_a_closed_set() {
        assert_eq!(super::verb("hr_request.approve"), "approve");
        assert_eq!(super::verb("access.grant.notice"), "other");
        assert_eq!(super::verb(""), "other");
    }
}
