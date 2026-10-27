// SPDX-License-Identifier: LicenseRef-Proprietary
//! Bound candidate hydration with the shared deadline keyset; decisions run over batched facts.
use super::*;
use console_compliance_adapter_postgres::statutory::StatutoryRegister;
use console_hr_domain::exits::settlement_due::SettlementDue;
use sqlx::{Postgres, QueryBuilder, Transaction};
use std::collections::BTreeSet;

pub(super) fn deadline_bands(register: &StatutoryRegister) -> Result<serde_json::Value, HrError> {
    let codes = [SettlementDue::FinalPay, SettlementDue::SeverancePay].map(|d| d.register_code());
    let boundaries: BTreeSet<_> = register
        .rules()
        .iter()
        .filter(|r| codes.contains(&r.code.as_str()))
        .flat_map(|r| [Some(r.effective_from), r.effective_to_exclusive])
        .flatten()
        .collect();
    let dates: Vec<_> = boundaries.into_iter().collect();
    let mut bands = Vec::new();
    for (i, from) in dates.iter().enumerate() {
        let days = settlement_deadlines(&from.to_string(), register)?
            .into_iter()
            .filter_map(|d| d.due_date)
            .map(|d| console_hr_domain::text::parse_yyyy_mm_dd(&d))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .min()
            .map(|due| (due - *from).whole_days());
        bands.push(serde_json::json!({ "start_on": from.to_string(), "end_on": dates.get(i+1).map(ToString::to_string), "days": days }));
    }
    Ok(serde_json::json!(bands))
}

pub(super) async fn candidates(
    tx: &mut Transaction<'_, Postgres>,
    reader: &Principal,
    bands: &serde_json::Value,
    query: &ActionInboxSourceQuery,
) -> Result<Vec<Exit>, HrError> {
    let mut q = QueryBuilder::new(
        "WITH candidates AS (SELECT c.id,c.employee_id,c.branch_id,e.name,e.worksite_name AS site,c.status, \
         c.effective_exit_date AS exit_date,c.hr_confirmed_by,c.created_at, \
         ((CASE WHEN c.status IN ('REPORTED','HR_CONFIRMED') THEN c.effective_exit_date \
           WHEN c.effective_exit_date <= ",
    );
    q.push_bind(Date::MAX).push(
        " - d.days THEN c.effective_exit_date + d.days END) + TIME '23:59:59.999999') AT TIME ZONE \
         lifecycle_time_zone(c.org_id,c.employee_id,c.effective_exit_date) AS due \
         FROM employee_exit_cases c JOIN person_employees_current e ON e.org_id=c.org_id AND e.id=c.employee_id ",
    );
    q.push(" LEFT JOIN employee_lifecycle_events l ON l.org_id=c.org_id AND l.id=c.exit_lifecycle_event_id \
        LEFT JOIN jsonb_to_recordset(").push_bind(bands.clone()).push(
        ") AS d(start_on date,end_on date,days int) ON c.effective_exit_date >= d.start_on \
         AND (d.end_on IS NULL OR c.effective_exit_date < d.end_on) WHERE c.org_id=");
    q.push_bind(*reader.org_id.as_uuid())
        .push(" AND c.created_at <= ")
        .push_bind(query.as_of);
    q.push(" AND c.status IN ('REPORTED','HR_CONFIRMED','HQ_CONFIRMED','SETTLEMENT_READY','APPROVAL_DRAFTED') \
        AND l.state IS DISTINCT FROM 'APPLY_FAILED') SELECT * FROM candidates WHERE TRUE");
    console_platform_db::inbox::push_page(
        &mut q,
        "due",
        "created_at",
        "('hr_exit:' || id::text)",
        query.after.clone().map(|p| (p.due, p.created_at, p.id)),
        i64::try_from(query.limit).unwrap_or(i64::MAX),
    );
    Ok(q.build_query_as().fetch_all(tx.as_mut()).await?)
}
