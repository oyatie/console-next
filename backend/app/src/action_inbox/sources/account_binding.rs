// SPDX-License-Identifier: LicenseRef-Proprietary
//! Self-attestation review uses the identity command's own visibility, clock and receipt.
use console_action_inbox_application::{
    ActionInboxLink, ActionInboxSourceItem, ActionInboxSourcePage, ActionInboxSourceQuery,
    page_source_items,
};
use console_identity_adapter_postgres::PgOrgStore;
use console_kernel_core::KernelError;
use console_platform_authz::Principal;

#[cfg(all(test, feature = "test-postgres"))]
#[path = "../../../tests/action_inbox/binding_review.rs"]
mod tests;

pub(crate) async fn page(
    pool: &sqlx::PgPool,
    principal: &Principal,
    query: ActionInboxSourceQuery,
) -> Result<ActionInboxSourcePage, KernelError> {
    let rows = PgOrgStore::new(pool.clone())
        .pending_self_binding_reviews(principal.user_id)
        .await
        .map_err(|error| {
            tracing::error!(?error, "binding review inbox failed");
            KernelError::internal("failed to load binding reviews")
        })?;
    let items: Vec<_> = rows
        .into_iter()
        .filter(|row| row.attested_at <= query.as_of)
        .map(|row| ActionInboxSourceItem {
            id: format!("account_binding_review:{}", row.id),
            kind: "account_binding_review".into(),
            title: row.employee_name,
            who: Some(row.account_name),
            due: Some(row.due),
            submitted: Some(row.attested_at),
            created_at: row.attested_at,
            context: Some(serde_json::json!({"command_id":row.id})),
            links: vec![ActionInboxLink {
                kind: "employee".into(),
                id: row.employee_id.to_string(),
                label: None,
            }],
            due_basis: None,
            ref_code: String::new(),
            site: None,
        })
        .collect();
    let total = items.len();
    let (items, has_more) = page_source_items(items, &query);
    Ok(ActionInboxSourcePage {
        items,
        total,
        total_is_exact: true,
        has_more,
    })
}
