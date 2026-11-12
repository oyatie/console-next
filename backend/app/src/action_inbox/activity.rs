// SPDX-License-Identifier: LicenseRef-Proprietary
//! One inbox item's activity (`/api/v1/me/action-inbox/items/{id}/activity`):
//! what happened to the item's own record, newest first. The item is resolved
//! through the caller's own inbox read (the list handler, so every source and
//! its authorization apply): another person's item, an unknown one and a
//! malformed id answer one 404. Rows carry who, what and when only, never the
//! audit snapshots, and only events on the request or case the item is about,
//! never on the person behind it.
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

/// The audit target types that are the item's own record, by the kind of its first link. A link kind with no
/// entry (a person, an account, a screen) serves no events: its audit trail is not the item's.
fn record_types(link_kind: &str) -> &'static [&'static str] {
    match link_kind {
        "change_request" => &["change_request"],
        "org_change" => &["org_change_request"],
        "period_lock" => &["period_lock"],
        "access" => &["access_grants"],
        "exit_case" => &["employee_exit_case"],
        _ => &[],
    }
}

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

/// The verb of an audit action code (`change_request.decide`, `period_lock.unlock_request`,
/// `org_change.apply.op`): the last known word after the domain prefix, else `other`.
fn verb(action: &str) -> &'static str {
    for segment in action
        .split('.')
        .skip(1)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
    {
        for word in segment.rsplit('_') {
            let known = match word {
                "create" => "create",
                "submit" | "request" => "submit",
                "approve" => "approve",
                "reject" | "decline" => "reject",
                "decide" => "decide",
                "apply" => "apply",
                "withdraw" => "withdraw",
                "cancel" => "cancel",
                "update" => "update",
                "confirm" | "notice" => "confirm",
                _ => continue,
            };
            return known;
        }
    }
    "other"
}

enum Resolved {
    Found { link_kind: String, record: String },
    Missing,
    Unavailable,
}

/// The item's first link when the item is in my inbox now. Pages through the same read as the list, stopping at
/// the item or after a bounded scan; a miss while a source was unavailable is not a 404.
async fn resolve(
    state: &ActionInboxState,
    principal: &Principal,
    id: &str,
) -> Result<Resolved, InboxError> {
    let mut cursor = None;
    let mut unavailable = false;
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
        unavailable |= page["unavailable"]
            .as_array()
            .is_some_and(|sources| !sources.is_empty());
        if let Some(item) = page["items"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|item| item["id"] == id)
        {
            let link = &item["links"][0];
            let field = |name: &str| link[name].as_str().unwrap_or_default().to_owned();
            return Ok(Resolved::Found {
                link_kind: field("kind"),
                record: field("id"),
            });
        }
        match page["next_cursor"].as_str() {
            Some(next) => cursor = Some(next.to_owned()),
            None => break,
        }
    }
    Ok(if unavailable {
        Resolved::Unavailable
    } else {
        Resolved::Missing
    })
}

pub(super) async fn list(
    State(state): State<ActionInboxState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> Result<Json<ActivityPage>, InboxError> {
    let (link_kind, record) = match resolve(&state, &principal, &id).await? {
        Resolved::Found { link_kind, record } => (link_kind, record),
        Resolved::Missing => {
            return Err(KernelError::not_found("no such inbox item")
                .with_code("inbox_item_not_found")
                .into());
        }
        Resolved::Unavailable => {
            return Err(KernelError::unavailable("inbox sources unavailable").into());
        }
    };
    let types: Vec<String> = record_types(&link_kind)
        .iter()
        .map(|t| (*t).to_owned())
        .collect();
    if types.is_empty() || record.is_empty() {
        return Ok(Json(ActivityPage { items: Vec::new() }));
    }
    let org = principal.org_id;
    let rows: Vec<(String, OffsetDateTime, Option<String>)> =
        console_platform_db::with_org_conn::<_, _, console_platform_db::DbError>(&state.pool, org, move |tx| {
            Box::pin(async move {
                // An org change's decisions are audited on its approval steps; they belong to the request.
                Ok(sqlx::query_as(
                    "SELECT a.action, a.occurred_at, p.display_name FROM audit_events a \
                     LEFT JOIN person_accounts_current p ON p.org_id = a.org_id AND p.id = a.actor \
                     WHERE a.org_id = $1 AND ((a.target_type = ANY($2) AND a.target_id = $3) \
                        OR ($4 AND a.target_type = 'org_change_approval_step' AND a.target_id IN \
                            (SELECT s.id::text FROM org_change_approval_steps s WHERE s.org_id = $1 AND s.request_id::text = $3))) \
                     ORDER BY a.occurred_at DESC, a.id DESC LIMIT $5",
                )
                .bind(org.as_uuid())
                .bind(&types)
                .bind(&record)
                .bind(link_kind == "org_change")
                .bind(LIMIT)
                .fetch_all(tx.as_mut())
                .await?)
            })
        })
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
    use super::{record_types, verb};

    #[test]
    fn verbs_come_from_the_codes_sources_write() {
        for (action, want) in [
            ("change_request.create", "create"),
            ("change_request.decide", "decide"),
            ("change_request.something_new", "other"),
            ("org_change.submit", "submit"),
            ("org_change.step.decide", "decide"),
            ("org_change.apply.op", "apply"),
            ("period_lock.unlock_request", "submit"),
            ("period_lock.unlock_approve", "approve"),
            ("period_lock.unlock_reject", "reject"),
            ("access.grant.notice", "confirm"),
            ("employee.exit.report", "other"),
            ("", "other"),
        ] {
            assert_eq!(verb(action), want, "{action}");
        }
    }

    #[test]
    fn a_person_or_account_link_serves_no_events() {
        for kind in ["employee", "account", "setup", "statutory", ""] {
            assert!(record_types(kind).is_empty(), "{kind}");
        }
    }
}
