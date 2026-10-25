// SPDX-License-Identifier: LicenseRef-Proprietary
//! Invert the shared register clock once per rule, before scanning event candidates.
use crate::HrError;
use console_compliance_domain::statutory::filing::{
    FilingAnchor, FilingAnchors, FilingRule, dates,
};
use console_hr_domain::text::parse_yyyy_mm_dd;
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use time::{Date, Duration};
use uuid::Uuid;

pub(super) async fn load(tx: &mut Transaction<'_, Postgres>, org: Uuid) -> Result<Value, HrError> {
    let go_live: Date = sqlx::query_scalar(
        "SELECT min((COALESCE(p.go_live_at,now()) AT TIME ZONE z.time_zone)::date) \
         FROM (SELECT $1::uuid AS id) tenant LEFT JOIN tenant_phase p ON p.org_id=tenant.id \
         CROSS JOIN LATERAL (SELECT time_zone FROM lifecycle_country_packs WHERE is_default \
           UNION SELECT time_zone FROM workplaces WHERE org_id=tenant.id \
           UNION SELECT time_zone FROM legal_entities WHERE org_id=tenant.id) z",
    )
    .bind(org)
    .fetch_one(tx.as_mut())
    .await?;
    // Discard archived versions before decoding and inverting the register clocks.
    let rows = sqlx::query("WITH source_bounds AS MATERIALIZED (SELECT min(on_date) AS first_on,max(on_date) AS last_on FROM ( \
      SELECT effective_date::date AS on_date FROM employee_lifecycle_events WHERE org_id=$1 UNION ALL \
      SELECT anchor_on FROM insurance_filing_requests WHERE org_id=$1 AND filing_kind<>'ACQUIRE_REQUESTED') sources) \
      SELECT r.code,r.effective_from,r.filing_rule FROM lifecycle_filing_rules r CROSS JOIN source_bounds b WHERE r.filing_rule IS NOT NULL \
        AND (r.filing_rule->>'age_trigger_years' IS NOT NULL OR (r.effective_from<=b.last_on+COALESCE((r.filing_rule->>'loss_offset_days')::int,0) \
          AND (r.effective_to_exclusive IS NULL OR b.first_on+COALESCE((r.filing_rule->>'loss_offset_days')::int,0)<r.effective_to_exclusive)))")
        .bind(org).fetch_all(tx.as_mut()).await?;
    let mut bounds = Vec::with_capacity(rows.len());
    for row in rows {
        let rule: FilingRule = serde_json::from_value(row.try_get("filing_rule")?)
            .map_err(|e| HrError::internal(e.to_string()))?;
        bounds.push(json!({"code":row.try_get::<String,_>("code")?,
            "effective_from":row.try_get::<Date,_>("effective_from")?.to_string(),
            "earliest_event_on":earliest_event_on(&rule, go_live)?.map(|d|d.to_string())}));
    }
    Ok(Value::Array(bounds))
}

fn earliest_event_on(rule: &FilingRule, go_live: Date) -> Result<Option<Date>, HrError> {
    // Birthdays and requests have independent anchors; only their exact assessment can exclude them.
    if rule.age_trigger_years.is_some() || rule.deadline.anchor == FilingAnchor::RequestDate {
        return Ok(None);
    }
    let offset = Duration::days(i64::from(rule.loss_offset_days.max(0)));
    let from = parse_yyyy_mm_dd(&rule.effective_from)? - offset;
    let due = |on: Date| -> Result<Option<Date>, HrError> {
        // The transfer A-side exit can only precede these event-owned anchors.
        Ok(dates(
            rule,
            &FilingAnchors {
                effective_date: Some(on),
                acquire_date: Some(on),
                exit_date: Some(on),
                loss_date: Some(rule.loss_on(on)?),
                work_month: Some(on),
                request_date: Some(on),
            },
            &[],
        )?
        .due_on
        .as_deref()
        .map(parse_yyyy_mm_dd)
        .transpose()?)
    };
    if due(from)?.is_none() {
        return Ok(None);
    }
    // Register clocks are monotone, including month boundaries and holiday roll.
    let (mut low, mut high) = (from.to_julian_day(), go_live.max(from).to_julian_day());
    while low < high {
        let middle = low + (high - low) / 2;
        let on = Date::from_julian_day(middle).map_err(|e| HrError::internal(e.to_string()))?;
        if due(on)?.is_some_and(|d| d < go_live) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    Ok(Some(
        Date::from_julian_day(low).map_err(|e| HrError::internal(e.to_string()))?,
    ))
}
