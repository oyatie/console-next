//! Incomplete statutory register facts, linked to the personnel card until recorded.

use console_action_inbox_application::{
    ActionInboxLink, ActionInboxSourceItem, ActionInboxSourcePage, ActionInboxSourceQuery,
};
use console_hr_adapter_postgres::HrService;
use console_kernel_core::KernelError;
use console_platform_authz::Principal;
use sqlx::PgPool;

const NAMESPACE: &str = "hr_register";

pub(crate) async fn page(
    pool: &PgPool,
    principal: &Principal,
    query: ActionInboxSourceQuery,
) -> Result<ActionInboxSourcePage, KernelError> {
    let after = query
        .after
        .map(|position| (position.created_at, position.id));
    let page = HrService::new(pool.clone())
        .register_review_inbox_page(principal, query.as_of, after, query.limit)
        .await
        .map_err(|error| {
            tracing::error!(source = NAMESPACE, error = %error.message, "action-inbox source read failed");
            KernelError::internal("failed to load action inbox")
        })?;
    let items = page
        .items
        .into_iter()
        .map(|(id, name, created_at)| ActionInboxSourceItem {
            context: None,
            id: format!("{NAMESPACE}:{id}"),
            kind: "register_review".to_owned(),
            ref_code: String::new(),
            title: name,
            site: None,
            who: None,
            due: None,
            submitted: None,
            links: vec![ActionInboxLink {
                kind: "employee".to_owned(),
                id: id.to_string(),
                label: None,
            }],
            created_at,
        })
        .collect();
    Ok(ActionInboxSourcePage {
        items,
        total: usize::try_from(page.total).unwrap_or(0),
        total_is_exact: true,
        has_more: page.has_more,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use console_kernel_core::{BranchScope, OrgId, UserId};
    use time::OffsetDateTime;

    #[tokio::test]
    async fn no_directory_manage_grant_exposes_no_register_followups() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
            .expect("valid lazy pool");
        let principal = Principal::new(
            UserId::new(),
            OrgId::new(),
            Default::default(),
            BranchScope::All,
        );
        let page = page(
            &pool,
            &principal,
            ActionInboxSourceQuery {
                filter: Default::default(),
                require_exact_total: false,
                now: OffsetDateTime::now_utc(),
                as_of: OffsetDateTime::now_utc(),
                after: None,
                limit: 10,
            },
        )
        .await
        .expect("a denied source is empty");
        assert!(page.items.is_empty());
        assert_eq!(page.total, 0);
        assert!(page.total_is_exact);
        assert!(!page.has_more);
    }
}
