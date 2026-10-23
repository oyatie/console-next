// SPDX-License-Identifier: LicenseRef-Proprietary
//! Tenant support approvals share the decision endpoint's catalog permission.
use console_action_inbox_application::{
    ActionInboxLink, ActionInboxSourceItem, ActionInboxSourcePage, ActionInboxSourceQuery,
};
use console_kernel_core::KernelError;
use console_platform_authz::Principal;
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(sqlx::FromRow)]
struct Pending {
    id: Uuid,
    ticket_ref: String,
    reason: String,
    operator_label: String,
    request_expires_at: OffsetDateTime,
    requested_at: OffsetDateTime,
}

pub(crate) async fn page(
    pool: &PgPool,
    principal: &Principal,
    query: ActionInboxSourceQuery,
) -> Result<ActionInboxSourcePage, KernelError> {
    let failure = |_| KernelError::internal("failed to load support approvals");
    let mut tx = pool.begin().await.map_err(failure)?;
    let allowed = console_platform_rest::tenant_support_permission(
        &mut tx,
        principal.org_id,
        *principal.user_id.as_uuid(),
    )
    .await
    .map_err(|_| KernelError::internal("failed to authorize support approvals"))?;
    if !allowed {
        return Ok(super::super::empty_source_page());
    }
    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM support_sessions WHERE org_id=$1 AND state='OPERATOR_APPROVED' AND tenant_approved_at IS NULL AND request_expires_at>$2 AND requested_at<=$3")
        .bind(principal.org_id.as_uuid()).bind(query.now).bind(query.as_of)
        .fetch_one(tx.as_mut()).await.map_err(failure)?;
    let (after_at, after_id) = query
        .after
        .map(|p| (Some(p.created_at), p.id))
        .unwrap_or_default();
    let mut rows = sqlx::query_as::<_, Pending>("SELECT id,ticket_ref,reason,operator_label,request_expires_at,requested_at FROM support_sessions WHERE org_id=$1 AND state='OPERATOR_APPROVED' AND tenant_approved_at IS NULL AND request_expires_at>$2 AND requested_at<=$3 AND ($4::timestamptz IS NULL OR (requested_at,'support_access:'||id::text)>($4,$5)) ORDER BY requested_at,id LIMIT $6")
        .bind(principal.org_id.as_uuid()).bind(query.now).bind(query.as_of).bind(after_at).bind(after_id)
        .bind(i64::try_from(query.limit.saturating_add(1)).map_err(|_| KernelError::validation("invalid inbox limit"))?)
        .fetch_all(tx.as_mut()).await.map_err(failure)?;
    tx.commit().await.map_err(failure)?;
    let has_more = rows.len() > query.limit;
    rows.truncate(query.limit);
    Ok(ActionInboxSourcePage {
        items: rows
            .into_iter()
            .map(|s| ActionInboxSourceItem {
                id: format!("support_access:{}", s.id),
                kind: "support_access".into(),
                ref_code: s.ticket_ref,
                title: s.reason,
                site: None,
                who: Some(s.operator_label),
                due: Some(s.request_expires_at),
                submitted: Some(s.requested_at),
                created_at: s.requested_at,
                links: vec![ActionInboxLink {
                    kind: "support_session".into(),
                    id: s.id.to_string(),
                    label: None,
                }],
            })
            .collect(),
        total: usize::try_from(total)
            .map_err(|_| KernelError::internal("invalid support approval count"))?,
        total_is_exact: true,
        has_more,
    })
}
