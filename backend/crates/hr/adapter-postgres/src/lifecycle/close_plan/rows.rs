//! The close job's rows (`workplace_close_jobs`, `workplace_close_lines`, 0310).

use serde_json::Value;
use sqlx::{Postgres, Row, Transaction};
use time::Date;
use uuid::Uuid;

use super::types::{CloseJob, JobLine};
use crate::HrError;
use crate::lifecycle::group_transfer::GroupTransferFacts;

/// A line as the apply reads it.
#[derive(Debug, Clone)]
pub(crate) struct Line {
    pub seq: i32,
    pub employee_id: Option<Uuid>,
    pub org_unit_id: Option<Uuid>,
    pub action: String,
    pub target_unit_id: Option<Uuid>,
    pub target_workplace_id: Option<Uuid>,
    pub lifecycle_event_id: Option<Uuid>,
    pub done: bool,
}

pub(crate) struct NewJob<'a> {
    pub id: Uuid,
    pub workplace_id: Uuid,
    pub legal_entity_id: Uuid,
    pub closed_on: Date,
    pub reason_code: Option<&'a str>,
    pub actor_id: Uuid,
    pub command_id: Uuid,
}

/// Insert the job and its lines (one statement for the lines: 2,000 people
/// are one round trip).
pub(crate) async fn insert(
    tx: &mut Transaction<'_, Postgres>,
    job: &NewJob<'_>,
    lines: &[NewLine],
) -> Result<(), HrError> {
    sqlx::query(
        "INSERT INTO workplace_close_jobs (org_id, id, workplace_id, legal_entity_id, closed_on, reason_code, actor_id, command_id) \
         VALUES (NULLIF(current_setting('app.current_org', true), '')::uuid, $1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(job.id)
    .bind(job.workplace_id)
    .bind(job.legal_entity_id)
    .bind(job.closed_on)
    .bind(job.reason_code)
    .bind(job.actor_id)
    .bind(job.command_id)
    .execute(tx.as_mut())
    .await?;
    let col = |f: fn(&NewLine) -> Option<Uuid>| lines.iter().map(f).collect::<Vec<_>>();
    sqlx::query(
        "INSERT INTO workplace_close_lines (org_id, job_id, seq, employee_id, org_unit_id, action, target_unit_id, \
           target_workplace_id, exit_reason_code, exit_case_id, lifecycle_event_id) \
         SELECT NULLIF(current_setting('app.current_org', true), '')::uuid, $1, x.seq - 1, x.e, x.u, x.a, x.t, x.w, x.r, x.c, x.l \
         FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::uuid[], $6::uuid[], $7::text[], $8::uuid[], $9::uuid[]) \
           WITH ORDINALITY AS x(e, u, a, t, w, r, c, l, seq)",
    )
    .bind(job.id)
    .bind(col(|l| l.employee_id))
    .bind(col(|l| l.org_unit_id))
    .bind(lines.iter().map(|l| l.action).collect::<Vec<_>>())
    .bind(col(|l| l.target_unit_id))
    .bind(col(|l| l.target_workplace_id))
    .bind(lines.iter().map(|l| l.exit_reason_code.clone()).collect::<Vec<_>>())
    .bind(col(|l| l.exit_case_id))
    .bind(col(|l| l.lifecycle_event_id))
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

#[derive(Debug, Clone)]
pub(crate) struct NewLine {
    pub employee_id: Option<Uuid>,
    pub org_unit_id: Option<Uuid>,
    pub action: &'static str,
    pub target_unit_id: Option<Uuid>,
    pub target_workplace_id: Option<Uuid>,
    pub exit_reason_code: Option<String>,
    pub exit_case_id: Option<Uuid>,
    /// GROUP_TRANSFER: the 전적 the plan recorded.
    pub lifecycle_event_id: Option<Uuid>,
    /// GROUP_TRANSFER: the checked facts to record it with (not stored here).
    pub group_transfer: Option<GroupTransferFacts>,
}

macro_rules! job_columns {
    () => {
        "id, workplace_id, closed_on, reason_code, state, failure, actor_id, command_id, \
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS created_at, \
         to_char(settled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS settled_at"
    };
}

/// A job's header as the apply needs it.
#[derive(Debug, Clone)]
pub(crate) struct Head {
    pub id: Uuid,
    pub workplace_id: Uuid,
    pub closed_on: Date,
    pub state: String,
    pub actor_id: Uuid,
    pub command_id: Uuid,
}

/// The job `id` (`FOR UPDATE SKIP LOCKED` when `lock`: a busy job is `None`).
pub(crate) async fn head(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    lock: bool,
) -> Result<Option<Head>, HrError> {
    let sql = if lock {
        concat!(
            "SELECT ",
            job_columns!(),
            " FROM workplace_close_jobs WHERE id = $1 FOR UPDATE SKIP LOCKED"
        )
    } else {
        concat!(
            "SELECT ",
            job_columns!(),
            " FROM workplace_close_jobs WHERE id = $1"
        )
    };
    let row = sqlx::query(sql)
        .bind(id)
        .fetch_optional(tx.as_mut())
        .await?;
    row.map(|r| {
        Ok(Head {
            id: r.try_get("id")?,
            workplace_id: r.try_get("workplace_id")?,
            closed_on: r.try_get("closed_on")?,
            state: r.try_get("state")?,
            actor_id: r.try_get("actor_id")?,
            command_id: r.try_get("command_id")?,
        })
    })
    .transpose()
    .map_err(|e: sqlx::Error| e.into())
}

/// The newest job of a 사업장 (the open one when there is one).
pub(crate) async fn latest_for(
    tx: &mut Transaction<'_, Postgres>,
    workplace: Uuid,
) -> Result<Option<Uuid>, HrError> {
    Ok(sqlx::query_scalar(
        "SELECT id FROM workplace_close_jobs WHERE workplace_id = $1 \
         ORDER BY (state IN ('SCHEDULED', 'WAITING')) DESC, created_at DESC LIMIT 1",
    )
    .bind(workplace)
    .fetch_optional(tx.as_mut())
    .await?)
}

/// Jobs whose 폐쇄일 has come and that have not settled.
pub(crate) async fn due(
    tx: &mut Transaction<'_, Postgres>,
    today: Date,
) -> Result<Vec<Uuid>, HrError> {
    Ok(sqlx::query_scalar(
        "SELECT id FROM workplace_close_jobs WHERE state IN ('SCHEDULED', 'WAITING') AND closed_on <= $1 \
         ORDER BY closed_on, created_at LIMIT 100",
    )
    .bind(today)
    .fetch_all(tx.as_mut())
    .await?)
}

pub(crate) async fn lines(
    tx: &mut Transaction<'_, Postgres>,
    job: Uuid,
) -> Result<Vec<Line>, HrError> {
    let rows = sqlx::query(
        "SELECT seq, employee_id, org_unit_id, action, target_unit_id, target_workplace_id, lifecycle_event_id, done \
         FROM workplace_close_lines WHERE job_id = $1 ORDER BY seq",
    )
    .bind(job)
    .fetch_all(tx.as_mut())
    .await?;
    rows.iter()
        .map(|r| {
            Ok(Line {
                seq: r.try_get("seq")?,
                employee_id: r.try_get("employee_id")?,
                org_unit_id: r.try_get("org_unit_id")?,
                action: r.try_get("action")?,
                target_unit_id: r.try_get("target_unit_id")?,
                target_workplace_id: r.try_get("target_workplace_id")?,
                lifecycle_event_id: r.try_get("lifecycle_event_id")?,
                done: r.try_get("done")?,
            })
        })
        .collect::<Result<_, sqlx::Error>>()
        .map_err(Into::into)
}

pub(crate) async fn mark_done(
    tx: &mut Transaction<'_, Postgres>,
    job: Uuid,
    seq: i32,
    event: Option<Uuid>,
) -> Result<(), HrError> {
    sqlx::query("UPDATE workplace_close_lines SET done = true, lifecycle_event_id = COALESCE($3, lifecycle_event_id) WHERE job_id = $1 AND seq = $2")
        .bind(job)
        .bind(seq)
        .bind(event)
        .execute(tx.as_mut())
        .await?;
    Ok(())
}

/// Settle or park the job: `APPLIED`, `FAILED` (with `failure`), `CANCELLED`
/// or `WAITING`.
pub(crate) async fn set_state(
    tx: &mut Transaction<'_, Postgres>,
    job: Uuid,
    state: &str,
    failure: Option<Value>,
) -> Result<(), HrError> {
    sqlx::query(
        "UPDATE workplace_close_jobs SET state = $2, failure = $3, \
           settled_at = CASE WHEN $2 IN ('APPLIED', 'FAILED', 'CANCELLED') THEN now() ELSE NULL END \
         WHERE id = $1",
    )
    .bind(job)
    .bind(state)
    .bind(failure)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

/// The job with its lines, as the API answers.
pub(crate) async fn view(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<CloseJob, HrError> {
    let r = sqlx::query(concat!(
        "SELECT ",
        job_columns!(),
        " FROM workplace_close_jobs WHERE id = $1"
    ))
    .bind(id)
    .fetch_one(tx.as_mut())
    .await?;
    let rows = sqlx::query(
        "SELECT employee_id, org_unit_id, action, target_unit_id, target_workplace_id, exit_reason_code, exit_case_id, \
                lifecycle_event_id, done FROM workplace_close_lines WHERE job_id = $1 ORDER BY seq",
    )
    .bind(id)
    .fetch_all(tx.as_mut())
    .await?;
    let lines = rows
        .iter()
        .map(|l| {
            Ok(JobLine {
                employee_id: l.try_get("employee_id")?,
                org_unit_id: l.try_get("org_unit_id")?,
                action: l.try_get("action")?,
                target_unit_id: l.try_get("target_unit_id")?,
                target_workplace_id: l.try_get("target_workplace_id")?,
                exit_reason_code: l.try_get("exit_reason_code")?,
                exit_case_id: l.try_get("exit_case_id")?,
                lifecycle_event_id: l.try_get("lifecycle_event_id")?,
                done: l.try_get("done")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;
    let closed_on: Date = r.try_get("closed_on")?;
    Ok(CloseJob {
        id: r.try_get("id")?,
        workplace_id: r.try_get("workplace_id")?,
        closed_on: closed_on.to_string(),
        reason_code: r.try_get("reason_code")?,
        state: r.try_get("state")?,
        failure: r.try_get("failure")?,
        created_at: r.try_get("created_at")?,
        settled_at: r.try_get("settled_at")?,
        lines,
    })
}
