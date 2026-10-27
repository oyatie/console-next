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
        ..FilingQuery::default()
    };
    let (page, total_is_exact) = match service
        .insurance_inbox_page(
            principal.clone(),
            request,
            register,
            query
                .after
                .clone()
                .map(|position| (position.due, position.created_at, position.id)),
        )
        .await
    {
        Ok(page) => page,
        Err(error) if error.status.as_u16() == 403 => return Ok(super::super::empty_source_page()),
        Err(_) => return Err(KernelError::internal("failed to load insurance filings")),
    };
    let has_more = page.next.is_some();
    let total = usize::try_from(page.total).unwrap_or(0);
    let items = page.items
        .into_iter()
        .map(|task| {
            let metadata = serde_json::to_value(&task).map_err(|_| KernelError::internal("failed to project filing identity"))?;
            Ok(ActionInboxSourceItem {
            context: Some(serde_json::json!({ "insurance": {
                "insurer": task.insurer, "kind": task.kind, "effective_date": task.effective_date,
                "employee_id": task.employee_id, "case_id": task.lifecycle_case_id.unwrap_or(task.event_id), "group_id": metadata.get("group_id")
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
                    PrimitiveDateTime::new(d, Time::MAX - time::Duration::nanoseconds(999))
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
        })
        .collect::<Result<Vec<_>, KernelError>>()?;
    Ok(ActionInboxSourcePage {
        items,
        total,
        total_is_exact,
        has_more,
    })
}
