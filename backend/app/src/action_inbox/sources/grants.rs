// SPDX-License-Identifier: LicenseRef-Proprietary
//! Pending grant notices use the account's own effective-access read.
use console_action_inbox_application::{
    ActionInboxLink, ActionInboxSourceItem, ActionInboxSourcePage, ActionInboxSourceQuery,
};
use console_kernel_core::KernelError;
use console_platform_access::{AccessService, effective};
use console_platform_authz::Principal;
use std::collections::BTreeSet;
use time::OffsetDateTime;

pub(crate) async fn page(
    pool: &sqlx::PgPool,
    principal: &Principal,
    query: ActionInboxSourceQuery,
) -> Result<ActionInboxSourcePage, KernelError> {
    let access = effective::me(&AccessService::new(pool.clone(), None), principal.clone())
        .await
        .map_err(|e| {
            tracing::error!(error = ?e, "grant inbox source failed");
            KernelError::internal("failed to load grant notices")
        })?;
    let org = principal.org_id;
    let user = principal.user_id;
    let (grant_times, security) = console_platform_db::with_org_conn::<_, _, console_platform_db::DbError>(pool, org, move |tx| Box::pin(async move {
        let times: Vec<(uuid::Uuid, OffsetDateTime)> = sqlx::query_as("SELECT id, granted_at FROM access_grants WHERE org_id = $1 AND account_id = $2 AND status = 'ACTIVE' AND (valid_to IS NULL OR valid_to > now())")
            .bind(org.as_uuid()).bind(user.as_uuid()).fetch_all(tx.as_mut()).await?;
        let security: Option<(OffsetDateTime, String)> = sqlx::query_as("SELECT created_at, display_name FROM users WHERE org_id = $1 AND id = $2 AND (SELECT count(*) FROM auth_webauthn_credentials WHERE org_id = $1 AND user_id = $2) = 1 AND NOT EXISTS (SELECT 1 FROM tenant_phase WHERE org_id = $1 AND phase = 'SETUP')")
            .bind(org.as_uuid()).bind(user.as_uuid()).fetch_optional(tx.as_mut()).await?;
        Ok((times, security))
    })).await.map_err(|e| { tracing::error!(error = ?e, "account inbox source failed"); KernelError::internal("failed to load account work") })?;
    let mut seen = BTreeSet::new();
    let mut items = Vec::new();
    for entry in access["entries"].as_array().into_iter().flatten() {
        let Some(id) = entry["grant_id"].as_str() else {
            continue;
        };
        if !entry["noticed_at"].is_null() || !seen.insert(id) {
            continue;
        }
        if access["is_ops"] == true {
            continue;
        }
        let Some(created_at) = grant_times
            .iter()
            .find(|(grant, _)| grant.to_string() == id)
            .map(|(_, at)| *at)
        else {
            continue;
        };
        if created_at > query.as_of {
            continue;
        }
        items.push(ActionInboxSourceItem {
            id: format!("grant_notice:{id}"),
            kind: "grant_notice".into(),
            ref_code: String::new(),
            title: entry["role_name_ko"].as_str().unwrap_or_default().into(),
            site: None,
            who: None,
            due: None,
            submitted: None,
            created_at,
            links: vec![ActionInboxLink {
                kind: "access".into(),
                id: id.into(),
                label: None,
            }],
        });
    }
    if let Some((created_at, display_name)) = security.filter(|(at, _)| *at <= query.as_of) {
        items.push(ActionInboxSourceItem {
            id: format!("account_security:{}", principal.user_id),
            kind: "account_security".into(),
            ref_code: String::new(),
            title: display_name,
            site: None,
            who: None,
            due: None,
            submitted: None,
            created_at,
            links: vec![ActionInboxLink {
                kind: "account".into(),
                id: principal.user_id.to_string(),
                label: None,
            }],
        });
    }
    let total = items.len();
    items.retain(|i| {
        query
            .after
            .as_ref()
            .is_none_or(|p| (i.created_at, &i.id) > (p.created_at, &p.id))
    });
    items.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
    let has_more = items.len() > query.limit;
    items.truncate(query.limit);
    Ok(ActionInboxSourcePage {
        items,
        total,
        total_is_exact: true,
        has_more,
    })
}
