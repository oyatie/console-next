//! Filing receipts reuse HR's dated employer scope and sensitive-fact projection.
use console_compliance_adapter_postgres::PgComplianceStore;
use console_hr_adapter_postgres::{HrService, statutory::FilingQuery};
use console_platform_authz::Principal;
use console_platform_db::command_outcomes::CommandOutcome;
use console_platform_request_context::record_access::{self, outcome::ReadFuture};
use serde_json::Value;
use sqlx::PgPool;
use std::collections::BTreeMap;
use uuid::Uuid;

pub(crate) fn read_outcome<'a>(
    pool: &'a PgPool,
    p: &'a Principal,
    out: &'a mut CommandOutcome,
) -> ReadFuture<'a> {
    Box::pin(async move {
        if handles(&out.touched) {
            readable_result(pool, p, out.result.as_mut()).await
        } else {
            record_access::all_readable(pool, p, &out.touched).await
        }
    })
}

fn handles(touched: &Value) -> bool {
    touched.as_array().is_some_and(|items| {
        !items.is_empty()
            && items.iter().all(|item| {
                item.get("type").and_then(Value::as_str) == Some("insurance_filing")
                    && item
                        .get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| Uuid::parse_str(id).is_ok())
            })
    })
}

pub(super) async fn readable_result(
    pool: &PgPool,
    p: &Principal,
    result: Option<&mut Value>,
) -> bool {
    let Some(result) = result else { return false };
    let Ok(register) = PgComplianceStore::new(pool.clone())
        .statutory_register()
        .await
    else {
        return false;
    };
    let hr = HrService::new(pool.clone());
    let mut pages = BTreeMap::new();
    let tasks = match result.get_mut("items") {
        Some(Value::Array(items)) if !items.is_empty() => items.iter_mut().collect::<Vec<_>>(),
        Some(_) => return false,
        None => vec![result],
    };
    for saved in tasks {
        let Some(event_id) = saved
            .get("event_id")
            .and_then(Value::as_str)
            .and_then(|id| Uuid::parse_str(id).ok())
        else {
            return false;
        };
        let Some(employee_id) = saved
            .get("employee_id")
            .and_then(Value::as_str)
            .and_then(|id| Uuid::parse_str(id).ok())
        else {
            return false;
        };
        if let std::collections::btree_map::Entry::Vacant(entry) = pages.entry(event_id) {
            let Ok(page) = hr
                .insurance_filings(
                    p.clone(),
                    FilingQuery {
                        event_id: Some(event_id),
                        ..FilingQuery::default()
                    },
                    register.clone(),
                )
                .await
            else {
                return false;
            };
            entry.insert(page);
        }
        let page = &pages[&event_id];
        let Some(current) = page.items.iter().find(|task| {
            employee_id == task.employee_id
                && saved.get("kind").and_then(Value::as_str) == Some(task.kind.as_str())
                && saved.get("insurer").and_then(Value::as_str) == Some(task.insurer.as_str())
        }) else {
            return false;
        };
        saved["can_record_sensitive_facts"] = Value::Bool(current.can_record_sensitive_facts);
        if !current.can_record_sensitive_facts
            && let Some(facts) = saved
                .get_mut("applicability_facts")
                .and_then(Value::as_object_mut)
        {
            facts.insert("birth_date".into(), Value::Null);
            facts.insert("monthly_income_won".into(), Value::Null);
        }
    }
    true
}

#[cfg(test)]
#[path = "../../tests/requests/statutory.rs"]
mod tests;
