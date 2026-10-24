//! Manual insurance tasks reuse the statutory panel's authorized projection.
use console_action_inbox_application::{
    ActionInboxLink, ActionInboxSourceItem, ActionInboxSourcePage, ActionInboxSourceQuery,
};
use console_hr_adapter_postgres::{HrService, statutory::FilingQuery};
use console_kernel_core::KernelError;
use console_platform_authz::Principal;
use sqlx::PgPool;
use time::{PrimitiveDateTime, Time, UtcOffset};

pub(crate) async fn page(
    pool: &PgPool,
    principal: &Principal,
    query: ActionInboxSourceQuery,
) -> Result<ActionInboxSourcePage, KernelError> {
    let register = console_compliance_adapter_postgres::PgComplianceStore::new(pool.clone())
        .statutory_register()
        .await
        .map_err(|_| KernelError::internal("failed to load statutory register"))?;
    let service = HrService::new(pool.clone());
    let request = FilingQuery {
        state: Some("PENDING".into()),
        limit: Some(query.limit),
        inbox_as_of: Some(query.as_of),
        inbox_after: query.after.map(|p| (p.created_at, p.id)),
        ..FilingQuery::default()
    };
    let result = if query.require_exact_total {
        service
            .insurance_filings(principal.clone(), request, register)
            .await
            .map(|page| (page, true))
    } else {
        service
            .insurance_inbox_page(principal.clone(), request, register)
            .await
    };
    let (page, total_is_exact) = match result {
        Ok(page) => page,
        Err(error) if error.status.as_u16() == 403 => {
            return Ok(ActionInboxSourcePage {
                items: Vec::new(),
                total: 0,
                total_is_exact: true,
                has_more: false,
            });
        }
        Err(_) => return Err(KernelError::internal("failed to load insurance filings")),
    };
    let has_more = page.next.is_some();
    let items = page
        .items
        .into_iter()
        .map(|task| ActionInboxSourceItem {
            context: Some(serde_json::json!({ "insurance": {
                "insurer": task.insurer, "kind": task.kind, "effective_date": task.effective_date
            }})),
            id: format!(
                "insurance_filing_{}_{}:{}",
                task.kind, task.insurer, task.event_id
            ),
            kind: "insurance_filing".into(),
            ref_code: String::new(),
            title: task.name,
            site: task.workplace_name,
            who: None,
            due: task
                .due_date
                .as_deref()
                .and_then(|d| console_hr_domain::text::parse_yyyy_mm_dd(d).ok())
                .map(|d| {
                    PrimitiveDateTime::new(d, Time::MAX)
                        .assume_offset(UtcOffset::from_hms(9, 0, 0).unwrap_or(UtcOffset::UTC))
                }),
            submitted: None,
            created_at: task.created_at,
            links: vec![ActionInboxLink {
                kind: "statutory".into(),
                id: task.event_id.to_string(),
                label: None,
            }],
        })
        .collect();
    Ok(ActionInboxSourcePage {
        items,
        total: usize::try_from(page.total).unwrap_or(0),
        total_is_exact,
        has_more,
    })
}
