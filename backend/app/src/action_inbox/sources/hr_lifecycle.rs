//! Action-inbox source owned by lane LIFE (BW-11 item 8): lifecycle events that
//! failed to apply on their date (APPLY_FAILED), for org-wide HR managers.
//!
//! An item stays until HR records the same kind again for that employee (the
//! fix), which is the only way to act on it: an APPLY_FAILED row is final.

use console_action_inbox_application::{
    ActionInboxLink, ActionInboxSourceItem, ActionInboxSourcePage, ActionInboxSourceQuery,
};
use console_kernel_core::KernelError;
use console_platform_authz::{Action, Feature, Principal, authorize_org_wide};
use console_platform_db::{DbError, with_org_conn};
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

const NAMESPACE: &str = "hr_lifecycle";

/// Still open: no later APPLIED or SCHEDULED event of the same kind. A macro
/// so each statement stays one literal (sqlx takes only static SQL).
macro_rules! open {
    () => {
        "l.org_id = $1 AND l.state = 'APPLY_FAILED' AND l.created_at <= $2 \
         AND NOT EXISTS (SELECT 1 FROM employee_lifecycle_events n \
           WHERE n.org_id = l.org_id AND n.employee_id = l.employee_id \
             AND n.event_type = l.event_type AND n.created_at > l.created_at \
             AND n.state IN ('APPLIED', 'SCHEDULED'))"
    };
}

type Row = (Uuid, Uuid, String, String, String, OffsetDateTime);

pub(crate) async fn page(
    pool: &PgPool,
    principal: &Principal,
    query: ActionInboxSourceQuery,
) -> Result<ActionInboxSourcePage, KernelError> {
    if authorize_org_wide(principal, Action::new(Feature::EmployeeDirectoryManage)).is_err() {
        return Ok(ActionInboxSourcePage {
            items: Vec::new(),
            total: 0,
            total_is_exact: true,
            has_more: false,
        });
    }
    let org = principal.org_id;
    let after = query.after.map(|p| (p.due, p.created_at, p.id));
    let (as_of, limit) = (query.as_of, query.limit);
    let (rows, total) = with_org_conn::<_, _, DbError>(pool, org, move |tx| {
        Box::pin(async move {
            let rows: Vec<Row> = sqlx::query_as(concat!(
                "SELECT l.id, l.employee_id, l.event_type, l.effective_date, e.name, l.created_at \
                 FROM employee_lifecycle_events l \
                 JOIN person_employees_current e ON e.org_id = l.org_id AND e.id = l.employee_id WHERE ",
                open!(),
                " AND ($4::text IS NULL OR $3::timestamptz IS NOT NULL OR (l.created_at, ('hr_lifecycle:' || l.id::text)) > ($5, $4)) \
                 ORDER BY l.created_at, ('hr_lifecycle:' || l.id::text) LIMIT $6"
            ))
            .bind(org.as_uuid())
            .bind(as_of)
            .bind(after.as_ref().and_then(|a| a.0))
            .bind(after.as_ref().map(|a| a.2.clone()))
            .bind(after.as_ref().map(|a| a.1))
            .bind(i64::try_from(limit).unwrap_or(i64::MAX).saturating_add(1))
            .fetch_all(tx.as_mut())
            .await?;
            let total: i64 = sqlx::query_scalar(concat!(
                "SELECT count(*) FROM employee_lifecycle_events l WHERE ",
                open!()
            ))
            .bind(org.as_uuid())
            .bind(as_of)
            .fetch_one(tx.as_mut())
            .await?;
            Ok((rows, total))
        })
    })
    .await
    .map_err(|error| {
        tracing::error!(source = NAMESPACE, error = ?error, "action-inbox source read failed");
        KernelError::internal("failed to load action inbox")
    })?;
    let has_more = rows.len() > limit;
    let items = rows
        .into_iter()
        .take(limit)
        .map(
            |(id, employee, kind, on, name, created_at)| ActionInboxSourceItem {
                context: Some(serde_json::json!({ "review_count": total, "lifecycle": {
                    "action_kind": kind, "effective_date": on
                }})),
                id: format!("{NAMESPACE}:{id}"),
                kind: "lifecycle_apply_failed".to_owned(),
                ref_code: String::new(),
                title: name,
                site: None,
                who: None,
                due: None,
                submitted: None,
                links: vec![ActionInboxLink {
                    kind: "employee".to_owned(),
                    id: employee.to_string(),
                    label: None,
                }],
                created_at,
            },
        )
        .collect();
    Ok(ActionInboxSourcePage {
        items,
        total: usize::try_from(total).unwrap_or(0),
        total_is_exact: true,
        has_more,
    })
}

#[cfg(test)]
#[path = "hr_lifecycle_tests.rs"]
mod tests;
