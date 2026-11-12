// SPDX-License-Identifier: LicenseRef-Proprietary
//! Done (`GET /api/v1/me/action-inbox/done`): what the caller decided, newest
//! first across sources. Each source keeps its open queue's grant, so a row
//! shows only while the caller may still read it. Not counted, not in `all`.
use axum::Extension;
use axum::Json;
use axum::extract::{Query, State};
use console_action_inbox_application::done::{DoneCursor, DoneItem, done_limit, merge_done};
use console_action_inbox_application::{
    ActionInboxLink, ActionInboxSourceItem, ActionInboxSourcePage,
};
use console_hr_adapter_postgres::HrService;
use console_kernel_core::KernelError;
use console_platform_authz::Principal;
use serde::Deserialize;
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

use super::{ActionInboxState, error::InboxError, sources::audit_personnel};

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct DoneQuery {
    limit: Option<usize>,
    cursor: Option<String>,
}

type Before = Option<(OffsetDateTime, String)>;

pub(super) async fn list(
    State(state): State<ActionInboxState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<DoneQuery>,
) -> Result<Json<serde_json::Value>, InboxError> {
    let limit = done_limit(query.limit);
    let before: Before = query
        .cursor
        .as_deref()
        .map(DoneCursor::decode)
        .transpose()?
        .map(|c| (c.completed_at, c.id));
    let fetch = i64::try_from(limit + 1).unwrap_or(i64::MAX);
    let pool = &state.pool;
    // One read at a time: this route takes no share of the open list's read permits.
    let mut items = hr_requests(pool, &principal, before.clone(), fetch).await?;
    items
        .extend(crate::lifecycle::inbox_done::done(pool, &principal, before.clone(), fetch).await?);
    items.extend(identifier_corrections(pool, &principal, before, fetch).await?);
    let (items, next) = merge_done(items, limit);
    record_access(pool, &principal, &items).await?;
    Ok(Json(serde_json::json!({
        "items": items,
        "next_cursor": next.map(|c| c.encode()),
    })))
}

async fn hr_requests(
    pool: &PgPool,
    principal: &Principal,
    before: Before,
    limit: i64,
) -> Result<Vec<DoneItem>, KernelError> {
    let rows = HrService::new(pool.clone())
        .change_request_done_page(principal, before, limit)
        .await
        .map_err(|error| {
            tracing::error!(source = "hr_requests", error = %error.message, "done source failed");
            KernelError::internal("failed to load finished work")
        })?;
    Ok(rows
        .into_iter()
        .map(|r| DoneItem {
            id: format!("hr_request:{}", r.id),
            kind: "hr_request".into(),
            title: r.title,
            outcome: r.status,
            completed_at: r.decided_at,
            links: vec![
                link("change_request", r.id),
                link(&r.subject_type.to_ascii_lowercase(), r.subject_id),
            ],
        })
        .collect())
}

/// Corrections the caller approved or declined, under the open queue's tenant-wide grant.
async fn identifier_corrections(
    pool: &PgPool,
    principal: &Principal,
    before: Before,
    limit: i64,
) -> Result<Vec<DoneItem>, KernelError> {
    if !super::sources::entity_corrections::reviews(principal) {
        return Ok(Vec::new());
    }
    let (org, me) = (principal.org_id, *principal.user_id.as_uuid());
    let (at, id) = before.map_or((None, None), |(at, id)| (Some(at), Some(id)));
    let rows: Vec<(Uuid, String, OffsetDateTime, String)> =
        console_platform_db::with_org_conn::<_, _, console_platform_db::DbError>(pool, org, move |tx| {
            Box::pin(async move {
                Ok(sqlx::query_as(
                    "SELECT e.id, e.status, e.decided_at, r.name FROM governed_exceptions e \
                     LEFT JOIN business_registrations b ON e.subject_type = 'BUSINESS_REGISTRATION' AND b.id = e.subject_id \
                     JOIN legal_entities h ON h.id = CASE WHEN e.subject_type = 'LEGAL_ENTITY' THEN e.subject_id ELSE b.legal_entity_id END \
                     JOIN LATERAL (SELECT name FROM legal_entity_revisions WHERE legal_entity_id = h.id ORDER BY version DESC LIMIT 1) r ON true \
                     WHERE e.org_id = $1 AND e.rule_code = 'ENTITY_IDENTIFIER_CORRECTION' AND e.decided_by = $2 \
                     AND e.status IN ('APPROVED', 'DECLINED') \
                     AND ($3::timestamptz IS NULL OR e.decided_at < $3 OR (e.decided_at = $3 \
                       AND ('identifier_correction:' || e.id::text) COLLATE \"C\" < $4)) \
                     ORDER BY e.decided_at DESC, ('identifier_correction:' || e.id::text) COLLATE \"C\" DESC LIMIT $5",
                )
                .bind(org.as_uuid())
                .bind(me)
                .bind(at)
                .bind(id)
                .bind(limit)
                .fetch_all(tx.as_mut())
                .await?)
            })
        })
        .await
        .map_err(|e| {
            tracing::error!(error = ?e, "correction done source failed");
            KernelError::internal("failed to load finished work")
        })?;
    Ok(rows
        .into_iter()
        .map(|(id, status, decided_at, name)| DoneItem {
            id: format!("identifier_correction:{id}"),
            kind: "identifier_correction".into(),
            title: name,
            outcome: status,
            completed_at: decided_at,
            links: vec![link("identifier_correction", id)],
        })
        .collect())
}

fn link(kind: &str, id: Uuid) -> ActionInboxLink {
    ActionInboxLink {
        kind: kind.to_owned(),
        id: id.to_string(),
        label: None,
    }
}

/// A name on a finished row is a personnel read: logged like the open list.
async fn record_access(
    pool: &PgPool,
    principal: &Principal,
    items: &[DoneItem],
) -> Result<(), KernelError> {
    let mut page = ActionInboxSourcePage {
        items: items
            .iter()
            .map(|i| ActionInboxSourceItem {
                context: None,
                id: i.id.clone(),
                kind: i.kind.clone(),
                ref_code: String::new(),
                title: String::new(),
                site: None,
                who: None,
                due: None,
                submitted: None,
                links: i.links.clone(),
                created_at: i.completed_at,
            })
            .collect(),
        total: items.len(),
        total_is_exact: true,
        has_more: false,
    };
    audit_personnel::record(pool, principal, &mut page).await
}
