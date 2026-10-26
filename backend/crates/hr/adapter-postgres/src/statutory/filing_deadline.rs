// SPDX-License-Identifier: LicenseRef-Proprietary
//! Rank the canonical assessment before hydrating the bounded visible page.
use super::filing_query::query_rows;
use super::{FilingPage, FilingQuery, FilingTask, filing_read};
use crate::HrError;
use console_compliance_domain::statutory::StatutoryRegister;
use console_hr_domain::text::parse_yyyy_mm_dd;
use console_platform_authz::Principal;
use sqlx::{Postgres, Row, Transaction, postgres::PgRow};
use std::collections::HashMap;
use time::{
    OffsetDateTime, PrimitiveDateTime,
    macros::{offset, time},
};

type Position = (Option<OffsetDateTime>, OffsetDateTime, String);

/// Assess the rank before hydrating; admission and auditing live at the canonical entry.
pub(super) async fn load(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    query: &FilingQuery,
    register: &StatutoryRegister,
    after: Option<Position>,
) -> Result<(FilingPage, bool), HrError> {
    sqlx::query("SET LOCAL jit = off")
        .execute(tx.as_mut())
        .await?;
    let limit = query.page_limit();
    let bounds = super::filing_boundary::load(tx, *principal.org_id.as_uuid()).await?;
    let mut candidates = if query.kind.as_deref() == Some("AGE60") {
        Vec::new()
    } else {
        query_rows(
            tx,
            principal,
            query,
            register,
            true,
            None,
            Some(bounds.clone()),
        )
        .await?
    };
    if query.kind.as_deref().is_none_or(|kind| kind == "AGE60") {
        let years = register
            .filing_rules()
            .iter()
            .filter(|rule| rule.insurer == "NPS" && rule.filing_kind == "AGE60")
            .filter_map(|rule| rule.age_trigger_years)
            .min();
        let has_birth = if let Some(years) = years {
            sqlx::query_scalar::<_, bool>("WITH clock AS MATERIALIZED (SELECT max(EXTRACT(year FROM (COALESCE($2,now()) AT TIME ZONE z.time_zone))) AS year FROM (SELECT time_zone FROM lifecycle_country_packs WHERE is_default UNION SELECT time_zone FROM workplaces WHERE org_id=$1 UNION SELECT time_zone FROM legal_entities WHERE org_id=$1) z) \
                SELECT EXISTS (SELECT 1 FROM person_employees_current x CROSS JOIN clock WHERE x.org_id=$1 AND EXTRACT(year FROM x.birth_date)+$3<=clock.year) \
                OR EXISTS (SELECT 1 FROM insurance_filing_records r CROSS JOIN clock WHERE r.org_id=$1 AND EXTRACT(year FROM (r.applicability_facts->>'birth_date')::date)+$3<=clock.year)")
                .bind(principal.org_id.as_uuid()).bind(query.inbox_as_of).bind(i32::from(years)).fetch_one(tx.as_mut()).await?
        } else {
            false
        };
        if has_birth {
            let age_query = FilingQuery {
                kind: Some("AGE60".into()),
                ..query.clone()
            };
            candidates.extend(
                query_rows(
                    tx,
                    principal,
                    &age_query,
                    register,
                    true,
                    None,
                    Some(bounds.clone()),
                )
                .await?,
            );
        }
    }
    let mut positions = Vec::new();
    for row in candidates {
        if terminal_receipt(&row)? {
            continue;
        }
        let Some(assessment) = filing_read::assessment(&row, register)? else {
            continue;
        };
        let due = due(assessment
            .dates
            .as_ref()
            .and_then(|dates| dates.due_on.as_deref()))?;
        let state = assessment.state;
        if row.try_get::<Option<bool>, _>("recording_held")? != Some(true)
            && matches!(state, "DONE" | "NOT_APPLICABLE" | "COVERED")
        {
            continue;
        }
        let ids: Vec<String> = row.try_get("inbox_ids")?;
        let created: Vec<OffsetDateTime> = row.try_get("inbox_created")?;
        positions.extend(
            ids.into_iter()
                .zip(created)
                .map(|(id, created)| (due, created, id)),
        );
    }
    let total = i64::try_from(positions.len()).unwrap_or(i64::MAX);
    positions.retain(|position| {
        after
            .as_ref()
            .is_none_or(|after| compare(position, after).is_gt())
    });
    positions.sort_by(compare);
    let mut items = Vec::new();
    let mut exact = true;
    let mut scanned = 0;
    for batch in positions.chunks(limit.saturating_add(1)) {
        scanned += batch.len();
        let ids: Vec<_> = batch.iter().map(|(_, _, id)| id.clone()).collect();
        let rows = query_rows(
            tx,
            principal,
            query,
            register,
            false,
            Some(ids),
            Some(bounds.clone()),
        )
        .await?;
        let mut hydrated: HashMap<_, _> = hydrate(tx, principal, query, register, rows)
            .await?
            .into_iter()
            .map(|task| (task.inbox_id(), task))
            .collect();
        for (_, _, id) in batch {
            if let Some(task) = hydrated.remove(id) {
                items.push(task);
            } else {
                exact = false;
            }
        }
        if items.len() > limit {
            break;
        }
    }
    let total = if !exact && after.is_none() && scanned == positions.len() {
        exact = true;
        i64::try_from(items.len()).unwrap_or(i64::MAX)
    } else if exact {
        total
    } else {
        i64::try_from(items.len()).unwrap_or(i64::MAX)
    };
    let more = items.len() > limit;
    items.truncate(limit);
    Ok((
        FilingPage {
            items,
            total,
            pending: total,
            next: more.then(|| "more".into()),
        },
        exact,
    ))
}

async fn hydrate(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    query: &FilingQuery,
    register: &StatutoryRegister,
    rows: Vec<PgRow>,
) -> Result<Vec<FilingTask>, HrError> {
    let mut pending = Vec::new();
    for row in rows {
        if !terminal_receipt(&row)? {
            pending.push(row);
        }
    }
    Ok(
        super::filings::visible_tasks(tx, principal, query, register, pending)
            .await?
            .into_iter()
            .filter(|task| !task.resolved())
            .collect(),
    )
}

fn terminal_receipt(row: &PgRow) -> Result<bool, HrError> {
    Ok(matches!(
        row.try_get::<Option<String>, _>("action")?.as_deref(),
        Some("COMPLETE" | "NOT_APPLICABLE")
    ))
}

fn due(on: Option<&str>) -> Result<Option<OffsetDateTime>, HrError> {
    on.map(|on| {
        Ok(
            PrimitiveDateTime::new(parse_yyyy_mm_dd(on)?, time!(23:59:59.999999))
                .assume_offset(offset!(+9)),
        )
    })
    .transpose()
}

fn compare(a: &Position, b: &Position) -> std::cmp::Ordering {
    a.0.is_none()
        .cmp(&b.0.is_none())
        .then_with(|| a.0.cmp(&b.0))
        .then_with(|| a.1.cmp(&b.1))
        .then_with(|| a.2.cmp(&b.2))
}
