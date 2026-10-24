use super::types::{FilingPage, FilingQuery};
use crate::authz::{Tier, authorize_hr_org_wide, hr_reach_in};
use crate::directory::access_log::{DirectoryAccess, access_event, actor_employee_id};
use crate::{HrError, HrService};
use console_compliance_domain::statutory::StatutoryRegister;
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use serde_json::json;
use sqlx::{Postgres, Transaction};

pub(super) async fn load(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    query: FilingQuery,
    register: &StatutoryRegister,
) -> Result<FilingPage, HrError> {
    let rows = super::filing_query::rows(tx, principal, &query).await?;
    let mut items = visible_tasks(tx, principal, &query, register, rows).await?;
    let pending = i64::try_from(items.iter().filter(|t| !t.resolved()).count()).unwrap_or(i64::MAX);
    if let Some(state) = &query.state {
        match state.as_str() {
            "PENDING" => items.retain(|t| !t.resolved()),
            "DONE" => items.retain(|t| t.resolved()),
            _ => return Err(HrError::validation("state must be PENDING or DONE")),
        }
    }
    let total = i64::try_from(items.len()).unwrap_or(i64::MAX);
    if let Some(after) = &query.after {
        let parts = after.split('|').collect::<Vec<_>>();
        if parts.len() != 4 {
            return Err(HrError::validation("invalid filing cursor"));
        }
        console_hr_domain::text::parse_yyyy_mm_dd(parts[0])?;
        uuid::Uuid::parse_str(parts[1])
            .map_err(|_| HrError::validation("invalid filing cursor"))?;
        items.retain(|t| {
            format!(
                "{}|{}|{}|{}",
                t.effective_date, t.event_id, t.kind, t.insurer
            ) > *after
        });
    }
    if let Some((created, id)) = &query.inbox_after {
        items.retain(|t| (t.created_at, t.inbox_id()) > (*created, id.clone()));
    }
    if query.inbox_as_of.is_some() {
        items.sort_by_key(|t| (t.created_at, t.inbox_id()));
    } else {
        items.sort_by_key(|t| {
            (
                t.effective_date.clone(),
                t.event_id,
                t.kind.clone(),
                t.insurer.clone(),
            )
        });
    }
    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    let more = items.len() > limit;
    items.truncate(limit);
    let next = items.last().filter(|_| more).map(|t| {
        format!(
            "{}|{}|{}|{}",
            t.effective_date, t.event_id, t.kind, t.insurer
        )
    });
    Ok(FilingPage {
        items,
        total,
        pending,
        next,
    })
}
async fn visible_tasks(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    query: &FilingQuery,
    register: &StatutoryRegister,
    rows: Vec<sqlx::postgres::PgRow>,
) -> Result<Vec<super::types::FilingTask>, HrError> {
    use sqlx::Row;
    let mut items = Vec::new();
    for row in rows {
        // Filter terminal receipts after LIMIT so their lateral lookup stays bounded.
        if query.inbox_scan_limit.is_some()
            && matches!(
                row.try_get::<Option<String>, _>("action")?.as_deref(),
                Some("COMPLETE" | "NOT_APPLICABLE")
            )
        {
            continue;
        }
        if let Some(task) = super::filing_read::task(row, register, query.inbox_as_of)? {
            items.push(task);
        }
    }
    super::filing_placement::place_ages(tx, principal, &mut items).await?;
    if let Some(site) = query.workplace_id {
        items.retain(|t| t.workplace_id == Some(site));
    }
    if let Some(entity) = query.legal_entity_id {
        items.retain(|t| t.legal_entity_id == Some(entity));
    }
    let sensitive = authorize_hr_org_wide(principal, Feature::EmployeeDirectoryManage).is_ok();
    // A birthday-derived loss exposes the exact birth date even with masked facts.
    if !sensitive {
        items.retain(|t| t.kind != "AGE60");
    }
    for task in &mut items {
        task.can_record_sensitive_facts = sensitive;
        if !sensitive {
            task.applicability_facts.birth_date = None;
            task.applicability_facts.monthly_income_won = None;
        }
    }
    Ok(items)
}

impl HrService {
    pub async fn insurance_filings(
        &self,
        principal: Principal,
        query: FilingQuery,
        register: StatutoryRegister,
    ) -> Result<FilingPage, HrError> {
        hr_reach_in(&principal, Feature::EmployeeDirectoryManage, Tier::Branch)?;
        with_audits::<_, _, HrError>(&self.pool, principal.org_id, move |tx| {
            Box::pin(async move {
                let page = load(tx, &principal, query, &register).await?;
                let ids = page.items.iter().map(|i| i.employee_id).collect::<Vec<_>>();
                let me = actor_employee_id(tx, &principal).await?;
                let event = access_event(
                    &principal,
                    DirectoryAccess::List,
                    &ids,
                    me,
                    json!({"view":"insurance_filings"}),
                )?;
                Ok((page, vec![event]))
            })
        })
        .await
    }
}

impl HrService {
    /// Keyset projection for the shared queue. Assess only a bounded candidate
    /// prefix, using the statutory panel's exact assessment and visibility.
    /// The count is a lower bound until the candidate set is exhausted.
    pub async fn insurance_inbox_page(
        &self,
        principal: Principal,
        mut query: FilingQuery,
        register: StatutoryRegister,
    ) -> Result<(FilingPage, bool), HrError> {
        use sqlx::Row;
        hr_reach_in(&principal, Feature::EmployeeDirectoryManage, Tier::Branch)?;
        with_audits::<_, _, HrError>(&self.pool, principal.org_id, move |tx| {
            Box::pin(async move {
                // This bounded read is latency-sensitive; JIT compilation costs
                // more than evaluating its small candidate prefix.
                sqlx::query("SET LOCAL jit = off")
                    .execute(tx.as_mut())
                    .await?;
                let limit = query.limit.unwrap_or(50).clamp(1, 200);
                let first = query.inbox_after.is_none();
                // Birthday tasks have a register-derived traversal instant; their
                // existing read computes that key before applying the cursor.
                let has_birth: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM employees WHERE org_id = $1 AND birth_date IS NOT NULL) OR EXISTS (SELECT 1 FROM insurance_filing_records WHERE org_id = $1 AND applicability_facts->>'birth_date' IS NOT NULL)")
                    .bind(principal.org_id.as_uuid()).fetch_one(tx.as_mut()).await?;
                let ages = if has_birth && query.kind.as_deref().is_none_or(|kind| kind == "AGE60") {
                    load(tx, &principal, FilingQuery {
                        kind: Some("AGE60".into()), state: Some("PENDING".into()),
                        inbox_as_of: query.inbox_as_of, inbox_after: query.inbox_after.clone(),
                        limit: Some(limit.saturating_add(1)), ..query.clone()
                    }, &register).await?
                } else {
                    FilingPage { items: Vec::new(), total: 0, pending: 0, next: None }
                };
                let batch = limit.saturating_add(1);
                query.inbox_scan_limit = Some(batch);
                let mut items = Vec::new();
                let mut exhausted = false;
                while items.len() <= limit && !exhausted {
                    let rows = super::filing_query::rows(tx, &principal, &query).await?;
                    exhausted = rows.len() < batch;
                    if let Some(last) = rows.last() {
                        query.inbox_after =
                            Some((last.try_get("created_at")?, last.try_get("inbox_id")?));
                    }
                    items.extend(
                        visible_tasks(tx, &principal, &query, &register, rows)
                            .await?
                            .into_iter()
                            .filter(|t| !t.resolved()),
                    );
                }
                let total = i64::try_from(items.len())
                    .unwrap_or(i64::MAX)
                    .saturating_add(ages.total);
                let age_more = ages.next.is_some();
                items.extend(ages.items);
                items.sort_by_key(|t| (t.created_at, t.inbox_id()));
                let more = items.len() > limit || !exhausted || age_more;
                items.truncate(limit);
                let next = more.then(|| "more".to_owned());
                let ids = items.iter().map(|i| i.employee_id).collect::<Vec<_>>();
                let me = actor_employee_id(tx, &principal).await?;
                let event = access_event(
                    &principal,
                    DirectoryAccess::List,
                    &ids,
                    me,
                    json!({"view":"insurance_filings"}),
                )?;
                Ok((
                    (
                        FilingPage {
                            items,
                            total,
                            pending: total,
                            next,
                        },
                        first && exhausted,
                    ),
                    vec![event],
                ))
            })
        })
        .await
    }
}
