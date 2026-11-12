// SPDX-License-Identifier: LicenseRef-Proprietary
//! 미루기 (`/api/v1/me/action-inbox/items/{id}/snooze`): the caller postpones
//! one of their own inbox items to a later day, or brings it back (다시 보기).
//! A snooze is the caller's view only: nothing on the item changes and nobody
//! else's list does. The item is resolved through the caller's own inbox read,
//! so someone else's item, an unknown id and a malformed id answer one 404.
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use console_action_inbox_application::{Snooze, SnoozeFacts, SnoozeRefusal, kst_date};
use console_kernel_core::{AuditAction, AuditEvent, KernelError, OrgId, UserId};
use console_platform_authz::Principal;
use console_platform_db::{DbError, with_audit};
use serde::Deserialize;
use serde_json::json;
use time::{Date, OffsetDateTime};

use super::activity::{Resolved, resolve};
use super::{ActionInboxState, error::InboxError};

/// Every snooze of the account; the read model drops the ones whose day has come.
pub(super) async fn load(
    conn: &mut sqlx::PgConnection,
    org: OrgId,
    account: UserId,
) -> Result<Vec<(String, Snooze)>, sqlx::Error> {
    let rows: Vec<(String, Date, Option<String>, OffsetDateTime)> = sqlx::query_as(
        "SELECT item_id, until, item_version, created_at FROM action_inbox_snoozes \
         WHERE org_id = $1 AND account_id = $2",
    )
    .bind(org.as_uuid())
    .bind(account.as_uuid())
    .fetch_all(conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, until, item_version, created_at)| {
            let snooze = Snooze {
                until,
                item_version,
                created_at,
            };
            (id, snooze)
        })
        .collect())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SnoozeBody {
    until: String,
}

/// A refusal: the inbox error body, or the one refusal that also names a date.
pub(super) enum Refused {
    Inbox(InboxError),
    /// On or after a legal deadline; the body carries the last day allowed.
    PastLegalDue(Date),
}

impl From<KernelError> for Refused {
    fn from(error: KernelError) -> Self {
        Self::Inbox(error.into())
    }
}

impl From<InboxError> for Refused {
    fn from(error: InboxError) -> Self {
        Self::Inbox(error)
    }
}

impl IntoResponse for Refused {
    fn into_response(self) -> Response {
        match self {
            Self::Inbox(error) => error.into_response(),
            Self::PastLegalDue(latest) => {
                let body = json!({"error": {
                    "code": "snooze_past_legal_due",
                    "message": "until: before the legal deadline",
                    "details": {"latest": latest.to_string()},
                }});
                (StatusCode::UNPROCESSABLE_ENTITY, Json(body)).into_response()
            }
        }
    }
}

/// The item as my list serves it, snoozed or not, and the database's now.
async fn mine(
    state: &ActionInboxState,
    principal: &Principal,
    id: &str,
) -> Result<(serde_json::Value, OffsetDateTime), Refused> {
    let item = match resolve(state, principal, id).await? {
        Resolved::Found(item) => item,
        Resolved::Missing => {
            return Err(KernelError::not_found("no such inbox item")
                .with_code("lifecycle.refuse.scope")
                .into());
        }
        Resolved::Unavailable => {
            return Err(KernelError::unavailable("inbox sources unavailable").into());
        }
    };
    let now = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&state.pool)
        .await
        .map_err(|error| KernelError::internal(format!("snooze clock: {error}")))?;
    Ok((item, now))
}

fn event(
    principal: &Principal,
    action: &str,
    id: &str,
    now: OffsetDateTime,
) -> Result<AuditEvent, KernelError> {
    Ok(AuditEvent::new(
        Some(principal.user_id),
        AuditAction::new(action)?,
        "action_inbox_snoozes",
        id,
        crate::telemetry::current_trace_context(),
        now,
    )
    .with_org(principal.org_id))
}

fn stored(error: DbError) -> KernelError {
    KernelError::internal(format!("snooze write: {error:?}"))
}

// console-gate: state-changing-handler
pub(super) async fn put(
    State(state): State<ActionInboxState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(body): Json<SnoozeBody>,
) -> Result<StatusCode, Refused> {
    let format = time::macros::format_description!("[year]-[month]-[day]");
    let until = Date::parse(&body.until, format)
        .map_err(|_| KernelError::validation("until: a date as YYYY-MM-DD").with_field("until"))?;
    let (item, now) = mine(&state, &principal, &id).await?;
    let today = kst_date(now);
    let facts: SnoozeFacts = serde_json::from_value(item["snooze"].clone())
        .map_err(|error| KernelError::internal(format!("snooze facts: {error}")))?;
    // The same facts the list served decide here; nothing is written on a refusal.
    match facts.check(until, today) {
        Ok(()) => {}
        Err(SnoozeRefusal::Past) => {
            return Err(KernelError::validation("until: a day after today")
                .with_code("snooze_past")
                .with_field("until")
                .into());
        }
        Err(SnoozeRefusal::NotAllowed) => {
            return Err(KernelError::conflict("someone is waiting on this decision")
                .with_code("snooze_not_allowed")
                .into());
        }
        Err(SnoozeRefusal::PastLegalDue(latest)) => return Err(Refused::PastLegalDue(latest)),
    }
    let version = item["version"].as_str().map(str::to_owned);
    let (org, account) = (principal.org_id, principal.user_id);
    let event = event(&principal, "action_inbox.snooze", &id, now)?
        .with_snapshots(None, Some(json!({"until": until.to_string()})));
    with_audit::<_, _, DbError>(&state.pool, event, move |tx| {
        Box::pin(async move {
            // A row whose day has come hides nothing any more: clear the account's stale ones here.
            sqlx::query(
                "DELETE FROM action_inbox_snoozes WHERE org_id = $1 AND account_id = $2 AND until <= $3",
            )
            .bind(org.as_uuid())
            .bind(account.as_uuid())
            .bind(today)
            .execute(tx.as_mut())
            .await?;
            // A new snooze starts over: its date, the version it saw and the moment it was made.
            sqlx::query(
                "INSERT INTO action_inbox_snoozes (org_id, account_id, item_id, until, item_version) \
                 VALUES ($1, $2, $3, $4, $5) ON CONFLICT (org_id, account_id, item_id) DO UPDATE \
                 SET until = EXCLUDED.until, item_version = EXCLUDED.item_version, created_at = now()",
            )
            .bind(org.as_uuid())
            .bind(account.as_uuid())
            .bind(id)
            .bind(until)
            .bind(version)
            .execute(tx.as_mut())
            .await?;
            Ok(())
        })
    })
    .await
    .map_err(stored)?;
    Ok(StatusCode::NO_CONTENT)
}

/// 다시 보기. Bringing back an item that is not snoozed changes nothing and still succeeds.
// console-gate: state-changing-handler
pub(super) async fn remove(
    State(state): State<ActionInboxState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> Result<StatusCode, Refused> {
    let (_, now) = mine(&state, &principal, &id).await?;
    let today = kst_date(now);
    let (org, account) = (principal.org_id, principal.user_id);
    let event = event(&principal, "action_inbox.unsnooze", &id, now)?;
    with_audit::<_, _, DbError>(&state.pool, event, move |tx| {
        Box::pin(async move {
            sqlx::query(
                "DELETE FROM action_inbox_snoozes WHERE org_id = $1 AND account_id = $2 \
                 AND (item_id = $3 OR until <= $4)",
            )
            .bind(org.as_uuid())
            .bind(account.as_uuid())
            .bind(id)
            .bind(today)
            .execute(tx.as_mut())
            .await?;
            Ok(())
        })
    })
    .await
    .map_err(stored)?;
    Ok(StatusCode::NO_CONTENT)
}
