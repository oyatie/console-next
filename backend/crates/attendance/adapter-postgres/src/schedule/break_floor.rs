//! §54① break-floor register. Rows are global and migration-only.

use console_attendance_domain::schedule::BreakFloorRow;
use sqlx::{Postgres, Row, Transaction};

use super::ScheduleStoreError;

const SQL: &str = "SELECT code, effective_from, effective_to_exclusive, work_minutes, rest_minutes, waiver \
     FROM attendance_break_floors ORDER BY code, effective_from";

pub(crate) async fn load(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<Vec<BreakFloorRow>, ScheduleStoreError> {
    let rows = sqlx::query(SQL).fetch_all(tx.as_mut()).await?;
    if rows.is_empty() {
        return Err(ScheduleStoreError::Corrupt("break_floor"));
    }
    rows.iter().map(row).collect()
}

fn row(r: &sqlx::postgres::PgRow) -> Result<BreakFloorRow, ScheduleStoreError> {
    let work: i32 = r.try_get("work_minutes")?;
    let rest: i32 = r.try_get("rest_minutes")?;
    Ok(BreakFloorRow {
        code: r.try_get("code")?,
        effective_from: r.try_get("effective_from")?,
        effective_to_exclusive: r.try_get("effective_to_exclusive")?,
        work_minutes: u16::try_from(work)
            .map_err(|_| ScheduleStoreError::Corrupt("break_floor"))?,
        rest_minutes: u16::try_from(rest)
            .map_err(|_| ScheduleStoreError::Corrupt("break_floor"))?,
        waiver: r.try_get("waiver")?,
    })
}
