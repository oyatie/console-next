// SPDX-License-Identifier: LicenseRef-Proprietary
use console_action_inbox_application::{
    ActionInboxLink, ActionInboxSourceItem, ActionInboxSourcePage, ActionInboxSourceQuery,
};
use console_entity_adapter_postgres::PgEntityStore;
use console_kernel_core::KernelError;
use console_platform_authz::Principal;
use sqlx::PgPool;

pub(crate) async fn page(
    pool: &PgPool,
    principal: &Principal,
    query: ActionInboxSourceQuery,
) -> Result<ActionInboxSourcePage, KernelError> {
    let rows =
        console_entity_rest::registration_check_inbox(&PgEntityStore::new(pool.clone()), principal)
            .await?;
    let mut items: Vec<_> = rows
        .into_iter()
        .filter(|row| row.created_at <= query.as_of)
        .map(|row| ActionInboxSourceItem {
            id: format!("registration_check:{}", row.id),
            kind: "registration_check".into(),
            ref_code: String::new(),
            title: row.entity_name,
            site: None,
            who: None,
            due: None,
            submitted: None,
            created_at: row.created_at,
            context: None,
            links: vec![ActionInboxLink {
                kind: "registration_check".into(),
                id: format!("{}/{}", row.legal_entity_id, row.registration_id),
                label: None,
            }],
        })
        .collect();
    let total = items.len();
    if let Some(after) = query.after {
        items.retain(|row| {
            row.created_at > after.created_at
                || row.created_at == after.created_at && row.id > after.id
        });
    }
    let has_more = items.len() > query.limit;
    items.truncate(query.limit);
    Ok(ActionInboxSourcePage {
        items,
        total,
        total_is_exact: true,
        has_more,
    })
}
