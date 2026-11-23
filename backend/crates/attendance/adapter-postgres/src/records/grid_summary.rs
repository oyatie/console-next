// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::{BTreeSet, HashMap};

use console_attendance_application::records_read::{GridRow, MonthGridSummary};
use console_attendance_domain::schedule::{DayKind, winner};
use sqlx::{Postgres, Row, Transaction};
use time::{Date, Weekday};
use uuid::Uuid;

use crate::schedule::ScheduleStoreError;
use crate::schedule::universe::Universe;

pub(super) async fn load_positions(
    tx: &mut Transaction<'_, Postgres>,
    ids: &[Uuid],
) -> Result<HashMap<Uuid, String>, ScheduleStoreError> {
    let mut positions = HashMap::new();
    if ids.is_empty() {
        return Ok(positions);
    }
    let pos_rows = sqlx::query(
        "SELECT e.id, \
         COALESCE(NULLIF(btrim(jt.label), ''), NULLIF(btrim(e.position), '')) AS position \
         FROM employees e \
         LEFT JOIN job_titles jt ON jt.org_id = e.org_id AND jt.id = e.job_title_id \
         WHERE e.id = ANY($1)",
    )
    .bind(ids)
    .fetch_all(&mut **tx)
    .await?;
    for row in pos_rows {
        let id: Uuid = row.try_get("id")?;
        if let Some(pos) = row.try_get::<Option<String>, _>("position")? {
            positions.insert(id, pos);
        }
    }
    Ok(positions)
}

pub(super) fn summarize_work_patterns(
    u: &Universe,
    page: &[crate::records::roster::Member],
    ref_date: Date,
) -> Option<String> {
    let mut pattern_names = BTreeSet::new();
    for member in page {
        if let Some(person) = member.on(ref_date) {
            let refs = u.layers_for(&person);
            if let Some(winning) = winner(&refs, ref_date)
                && let Some(pattern) = u.patterns.get(&winning.pattern_id)
            {
                pattern_names.insert(pattern.name.clone());
            }
        }
    }
    if pattern_names.is_empty() {
        None
    } else if pattern_names.len() == 1 {
        pattern_names.into_iter().next()
    } else {
        let first_name = pattern_names.iter().next().cloned().unwrap_or_default();
        Some(format!("{first_name} (+{})", pattern_names.len() - 1))
    }
}

pub(super) fn summarize_month_grid(
    u: &Universe,
    days: &[Date],
    rows: &[GridRow],
) -> MonthGridSummary {
    let scheduled_days = rows
        .iter()
        .map(|r| {
            i64::try_from(
                r.cells
                    .iter()
                    .filter(|c| c.plan_kind == DayKind::Work)
                    .count(),
            )
            .unwrap_or(0)
        })
        .max()
        .unwrap_or(0);
    let weekday_holiday_dates: BTreeSet<Date> = if rows.is_empty() {
        days.iter()
            .copied()
            .filter(|d| {
                !matches!(d.weekday(), Weekday::Saturday | Weekday::Sunday)
                    && u.public.contains_key(d)
            })
            .collect()
    } else {
        rows.iter()
            .flat_map(|r| r.cells.iter())
            .filter(|c| {
                !matches!(c.date.weekday(), Weekday::Saturday | Weekday::Sunday)
                    && matches!(
                        c.plan_kind,
                        DayKind::PublicHoliday
                            | DayKind::SubstituteHoliday
                            | DayKind::ElectionDay
                            | DayKind::LaborDay
                            | DayKind::ContractualHoliday
                    )
            })
            .map(|c| c.date)
            .collect()
    };
    MonthGridSummary {
        scheduled_days,
        weekday_holidays: i64::try_from(weekday_holiday_dates.len()).unwrap_or(0),
        recognised_minutes: rows.iter().map(|r| i64::from(r.totals.recognised)).sum(),
        outside_minutes: rows
            .iter()
            .map(|r| i64::from(r.totals.outside_scheduled))
            .sum(),
        unapproved_minutes: rows.iter().map(|r| i64::from(r.totals.unrecognised)).sum(),
        blocking_count: rows.iter().map(|r| r.totals.blocking).sum(),
        decision_count: rows.iter().map(|r| r.totals.decision).sum(),
        issue_people_count: i64::try_from(
            rows.iter()
                .filter(|r| r.totals.blocking > 0 || r.totals.decision > 0)
                .count(),
        )
        .unwrap_or(0),
        overtime_people_count: i64::try_from(
            rows.iter()
                .filter(|r| r.totals.outside_scheduled > 0 || r.totals.unrecognised > 0)
                .count(),
        )
        .unwrap_or(0),
    }
}
