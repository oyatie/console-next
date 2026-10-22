//! Action-inbox source owned by lane PEOPLE (BW-17 change requests the viewer
//! can decide: OPEN, not their own, open to HR or named to them).

use console_action_inbox_application::{
    ActionInboxLink, ActionInboxSourceItem, ActionInboxSourcePage, ActionInboxSourceQuery,
};
use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::requests::inbox::INBOX_ID_PREFIX;
use console_kernel_core::KernelError;
use console_platform_authz::Principal;
use sqlx::PgPool;

pub(crate) async fn page(
    pool: &PgPool,
    principal: &Principal,
    query: ActionInboxSourceQuery,
) -> Result<ActionInboxSourcePage, KernelError> {
    let after = query
        .after
        .map(|position| (position.created_at, position.id));
    let limit = i64::try_from(query.limit).unwrap_or(200);
    let page = HrService::new(pool.clone())
        .change_request_inbox_page(principal, query.as_of, after, limit)
        .await
        .map_err(|error| {
            tracing::error!(source = "hr_requests", error = %error.message, "action-inbox source read failed");
            KernelError::internal("failed to load action inbox")
        })?;
    let items = page
        .items
        .into_iter()
        .map(|request| ActionInboxSourceItem {
            context: None,
            id: format!("{INBOX_ID_PREFIX}{}", request.id),
            kind: "hr_request".to_owned(),
            ref_code: request.reason_code,
            title: request.kind,
            site: None,
            who: None,
            due: None,
            submitted: Some(request.created_at),
            links: vec![
                ActionInboxLink {
                    kind: "change_request".to_owned(),
                    id: request.id.to_string(),
                    label: None,
                },
                ActionInboxLink {
                    kind: request.subject_type.to_ascii_lowercase(),
                    id: request.subject_id.to_string(),
                    label: None,
                },
            ],
            created_at: request.created_at,
        })
        .collect();
    Ok(ActionInboxSourcePage {
        items,
        total: usize::try_from(page.total).unwrap_or(0),
        total_is_exact: true,
        has_more: page.has_more,
    })
}
