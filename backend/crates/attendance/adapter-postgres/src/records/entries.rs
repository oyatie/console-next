//! Reading entries: the current value of each person-day (the newest entry
//! of a live batch) and a person's whole history.

use std::collections::HashMap;

use console_attendance_application::records_read::EntryRead;
use console_attendance_domain::records::EntryKind;
use console_attendance_domain::schedule::Window;
use sqlx::{Postgres, Row, Transaction};
use time::Date;
use uuid::Uuid;

use crate::schedule::ScheduleStoreError;

const COLUMNS: &str = "e.id, e.batch_id, e.employee_id, e.work_date, e.kind, e.segments, e.reason, e.supersedes_id, \
     e.created_at, b.source, b.evidence_kind, b.undone_at IS NOT NULL AS undone, COALESCE(u.display_name, '') AS created_by_name \
     FROM attendance_entries e JOIN attendance_batches b ON b.id = e.batch_id AND b.org_id = e.org_id \
     LEFT JOIN person_accounts_current u ON u.id = e.created_by AND u.org_id = e.org_id";

pub(crate) fn entry_from(
    row: &sqlx::postgres::PgRow,
) -> Result<(Uuid, Date, EntryRead), ScheduleStoreError> {
    let kind: String = row.try_get("kind")?;
    let segments: serde_json::Value = row.try_get("segments")?;
    let segments: Vec<Window> =
        serde_json::from_value(segments).map_err(|_| ScheduleStoreError::Corrupt("segments"))?;
    Ok((
        row.try_get("employee_id")?,
        row.try_get("work_date")?,
        EntryRead {
            id: row.try_get("id")?,
            batch_id: row.try_get("batch_id")?,
            kind: EntryKind::parse(&kind).ok_or(ScheduleStoreError::Corrupt("entry kind"))?,
            segments,
            source: row.try_get("source")?,
            evidence_kind: row.try_get("evidence_kind")?,
            reason: row.try_get("reason")?,
            supersedes_id: row.try_get("supersedes_id")?,
            undone: row.try_get("undone")?,
            created_at: row.try_get("created_at")?,
            created_by_name: row.try_get("created_by_name")?,
        },
    ))
}

/// The current entry of each (person, day) in [first, last]; a VOID entry
/// is current too (the day reads empty and its history shows why).
pub(crate) async fn current(
    tx: &mut Transaction<'_, Postgres>,
    first: Date,
    last: Date,
    people: Option<&[Uuid]>,
) -> Result<HashMap<(Uuid, Date), EntryRead>, ScheduleStoreError> {
    let sql = format!(
        "SELECT DISTINCT ON (e.employee_id, e.work_date) {COLUMNS} \
         WHERE b.undone_at IS NULL AND e.work_date BETWEEN $1 AND $2 AND ($3::uuid[] IS NULL OR e.employee_id = ANY($3)) \
         ORDER BY e.employee_id, e.work_date, e.created_at DESC, e.id DESC"
    );
    let people: Option<Vec<Uuid>> = people.map(<[Uuid]>::to_vec);
    let rows = sqlx::query(sqlx::AssertSqlSafe(&*sql))
        .bind(first)
        .bind(last)
        .bind(&people)
        .fetch_all(tx.as_mut())
        .await?;
    rows.iter()
        .map(|r| entry_from(r).map(|(e, d, x)| ((e, d), x)))
        .collect()
}

/// Every entry of one person in [first, last], newest first, undone included.
pub(crate) async fn history(
    tx: &mut Transaction<'_, Postgres>,
    employee: Uuid,
    first: Date,
    last: Date,
) -> Result<Vec<(Date, EntryRead)>, ScheduleStoreError> {
    let sql = format!(
        "SELECT {COLUMNS} WHERE e.employee_id = $1 AND e.work_date BETWEEN $2 AND $3 ORDER BY e.created_at DESC, e.id DESC"
    );
    let rows = sqlx::query(sqlx::AssertSqlSafe(&*sql))
        .bind(employee)
        .bind(first)
        .bind(last)
        .fetch_all(tx.as_mut())
        .await?;
    rows.iter()
        .map(|r| entry_from(r).map(|(_, d, x)| (d, x)))
        .collect()
}

/// One entry by id with its person and day.
pub(crate) async fn one(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<Option<(Uuid, Date, EntryRead)>, ScheduleStoreError> {
    let sql = format!("SELECT {COLUMNS} WHERE e.id = $1");
    sqlx::query(sqlx::AssertSqlSafe(&*sql))
        .bind(id)
        .fetch_optional(tx.as_mut())
        .await?
        .as_ref()
        .map(entry_from)
        .transpose()
}
