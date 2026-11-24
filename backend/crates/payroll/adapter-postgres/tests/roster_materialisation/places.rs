// SPDX-License-Identifier: LicenseRef-Proprietary
//! Legal entities, workplaces, departments, dated assignments and pay groups for
//! the placement and pay-group roster tests, and the reads that observe a line.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use super::seed::Fixture;
use console_kernel_core::kr::synthetic;
use console_payroll_adapter_postgres::lifecycle::{
    ClosePreflight, close_attendance_in_tx, close_preflight_in_tx,
};
use console_payroll_adapter_postgres::roster::materialise_roster_in_tx;
use sqlx::PgPool;
use time::macros::date;
use time::{Date, OffsetDateTime};
use uuid::Uuid;

/// Before every period these tests use, so an assignment from it covers them all.
pub(crate) const LONG_AGO: Date = date!(2026 - 01 - 01);

/// A line's source key, 법인, 사업장 and department.
pub(crate) type Placed = (String, Option<Uuid>, Option<Uuid>, Option<Uuid>);

pub(crate) async fn entity(pool: &PgPool, org: Uuid) -> Uuid {
    sqlx::query_scalar("INSERT INTO legal_entities (org_id,id,needs_confirmation,created_change_mode) VALUES ($1,gen_random_uuid(),true,'MIGRATION') RETURNING id")
        .bind(org).fetch_one(pool).await.unwrap()
}

/// A 법인 whose name payroll may print: a confirmed, open 등록증 and a revision.
pub(crate) async fn named_entity(pool: &PgPool, org: Uuid, name: &str) -> Uuid {
    let entity: Uuid = sqlx::query_scalar("INSERT INTO legal_entities (org_id,id,biz_kind,created_change_mode) VALUES ($1,gen_random_uuid(),'CORPORATION','MIGRATION') RETURNING id")
        .bind(org).fetch_one(pool).await.unwrap();
    let registration: Uuid = sqlx::query_scalar("INSERT INTO business_registrations (org_id,id,legal_entity_id,brn,created_change_mode) VALUES ($1,gen_random_uuid(),$2,$3,'MIGRATION') RETURNING id")
        .bind(org).bind(entity).bind(synthetic::brn(81, 3).replace('-', "")).fetch_one(pool).await.unwrap();
    sqlx::query("INSERT INTO legal_entity_revisions (org_id,legal_entity_id,version,command_id,effective_from,name,change_mode,reason_code,payload_digest,settings_snapshot) VALUES ($1,$2,1,gen_random_uuid(),$3,$4,'MIGRATION','CREATE',decode(repeat('00',32),'hex'),'{}')")
        .bind(org).bind(entity).bind(LONG_AGO).bind(name).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO business_registration_revisions (org_id,registration_id,version,command_id,effective_from,trade_name,opened_on,status,change_mode,reason_code,payload_digest,settings_snapshot) VALUES ($1,$2,1,gen_random_uuid(),$3,'GANATECH',$3,'CONTINUING','MIGRATION','CREATE',decode(repeat('00',32),'hex'),'{}')")
        .bind(org).bind(registration).bind(LONG_AGO).execute(pool).await.unwrap();
    entity
}

pub(crate) async fn workplace(pool: &PgPool, org: Uuid, entity: Uuid) -> Uuid {
    sqlx::query_scalar("INSERT INTO workplaces (org_id,id,legal_entity_id,needs_confirmation,created_change_mode) VALUES ($1,gen_random_uuid(),$2,true,'MIGRATION') RETURNING id")
        .bind(org).bind(entity).fetch_one(pool).await.unwrap()
}

pub(crate) async fn unit(pool: &PgPool, org: Uuid) -> Uuid {
    sqlx::query_scalar("INSERT INTO org_units (org_id) VALUES ($1) RETURNING id")
        .bind(org)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// An employee keyed `key`, in `unit` today, with an employment status and span.
pub(crate) async fn person(
    pool: &PgPool,
    org: Uuid,
    key: &str,
    unit: Option<Uuid>,
    status: &str,
    (hire_on, exit_on): (Option<Date>, Option<Date>),
) -> Uuid {
    sqlx::query_scalar("INSERT INTO employees (org_id,company,name,source_filename,source_sheet,source_row,source_key,org_unit_id,employment_status,hire_on,exit_on) VALUES ($1,'SAE',$2,'book.xlsx','s',1,$2,$3,$4,$5,$6) RETURNING id")
        .bind(org).bind(key).bind(unit).bind(status).bind(hire_on).bind(exit_on)
        .fetch_one(pool).await.unwrap()
}

pub(crate) async fn active(pool: &PgPool, org: Uuid, key: &str, unit: Option<Uuid>) -> Uuid {
    person(pool, org, key, unit, "ACTIVE", (None, None)).await
}

/// A 법인 · 사업장 assignment over `[from, to)`; no 법인 records an unmapped migration.
pub(crate) async fn assign(
    pool: &PgPool,
    org: Uuid,
    employee: Uuid,
    place: Option<(Uuid, Uuid)>,
    (from, to): (Date, Option<Date>),
) {
    sqlx::query("INSERT INTO employment_assignments (org_id,employee_id,legal_entity_id,workplace_id,valid_from,valid_to,cause,command_id) VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $3::uuid IS NULL THEN 'MIGRATION_UNMAPPED' ELSE 'MIGRATION' END,gen_random_uuid())")
        .bind(org).bind(employee).bind(place.map(|p| p.0)).bind(place.map(|p| p.1)).bind(from).bind(to)
        .execute(pool).await.unwrap();
}

/// Ends the open assignment on `on` and opens one at `place` from that day.
pub(crate) async fn transfer(
    pool: &PgPool,
    org: Uuid,
    employee: Uuid,
    place: (Uuid, Uuid),
    on: Date,
) {
    sqlx::query("UPDATE employment_assignments SET valid_to=$3 WHERE org_id=$1 AND employee_id=$2 AND valid_to IS NULL AND superseded_at IS NULL")
        .bind(org).bind(employee).bind(on).execute(pool).await.unwrap();
    assign(pool, org, employee, Some(place), (on, None)).await;
}

pub(crate) async fn user(pool: &PgPool, org: Uuid) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO users (id, org_id, display_name) VALUES (gen_random_uuid(), $1, 'Recorder') RETURNING id",
    )
    .bind(org)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// An applied department move effective `on`, recorded with the department it left.
pub(crate) async fn department_move(
    pool: &PgPool,
    org: Uuid,
    employee: Uuid,
    (from, to): (Uuid, Uuid),
    on: Date,
) {
    let recorder = user(pool, org).await;
    sqlx::query("INSERT INTO employee_lifecycle_events (org_id,employee_id,event_type,from_status,to_status,from_org_unit_id,to_org_unit_id,effective_date,comment,created_by,state) VALUES ($1,$2,'TRANSFER','ACTIVE','ACTIVE',$3,$4,$5::date::text,'부서 이동',$6,'APPLIED')")
        .bind(org).bind(employee).bind(from).bind(to).bind(on).bind(recorder)
        .execute(pool).await.unwrap();
}

/// A non-sensitive pay group of `entity` whose base period follows `base_period`.
pub(crate) async fn pay_group(pool: &PgPool, org: Uuid, entity: Uuid, base_period: &str) -> Uuid {
    sqlx::query_scalar("INSERT INTO pay_groups (org_id,id,legal_entity_id,name,pay_date_rule,base_period,variable_period,proration,channel,sensitive,pay_basis_allowed) VALUES ($1,gen_random_uuid(),$2,'월급 '||gen_random_uuid(),'{\"day\":\"LAST_DAY\",\"month_offset\":0,\"non_business_day\":\"PREVIOUS\"}',$3::jsonb,'{\"start_day\":16,\"month_offset\":-1}','CALENDAR_DAYS','ATTESTATION_ONLY',false,ARRAY['MONTHLY']) RETURNING id")
        .bind(org).bind(entity).bind(base_period).fetch_one(pool).await.unwrap()
}

/// A June 2026 run of `group` with base period `period`, as run creation stores it.
pub(crate) async fn group_run(
    pool: &PgPool,
    org: Uuid,
    group: Uuid,
    kind: &str,
    period: (Date, Date),
) -> Fixture {
    let run = sqlx::query_scalar("INSERT INTO payroll_draft_runs (org_id,pay_group_id,kind,attribution_month,pay_date,period_start,period_end,variable_period_start,variable_period_end,source_label) VALUES ($1,$2,$3,DATE '2026-06-01',DATE '2026-06-30',$4,$5,$4,$5,'group-run') RETURNING id")
        .bind(org).bind(group).bind(kind).bind(period.0).bind(period.1)
        .fetch_one(pool).await.unwrap();
    Fixture { org, run }
}

pub(crate) async fn materialise_for(pool: &PgPool, f: &Fixture, period: (Date, Date)) -> u64 {
    let mut tx = pool.begin().await.unwrap();
    let n = materialise_roster_in_tx(&mut tx, f.org, f.run, period.0, period.1)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    n
}

pub(crate) async fn lock_period(pool: &PgPool, org: Uuid, (start, end): (Date, Date)) {
    sqlx::query("INSERT INTO period_locks (org_id,domain,period_start,period_end,reason) VALUES ($1,'payroll',$2,$3,'급여 동결')")
        .bind(org).bind(start).bind(end).execute(pool).await.unwrap();
}

/// Attendance close as the close command runs it; the error is kept, not unwrapped.
pub(crate) async fn close(pool: &PgPool, f: &Fixture) -> Result<(), String> {
    let actor = user(pool, f.org).await;
    let mut tx = pool.begin().await.unwrap();
    close_attendance_in_tx(&mut tx, f.run, actor, OffsetDateTime::now_utc())
        .await
        .map_err(|error| format!("{error:?}"))?;
    tx.commit().await.unwrap();
    Ok(())
}

/// The close preflight in its own committed transaction, as the read endpoint runs it.
pub(crate) async fn preflight(pool: &PgPool, f: &Fixture) -> ClosePreflight {
    let mut tx = pool.begin().await.unwrap();
    let verdict = close_preflight_in_tx(&mut tx, f.run)
        .await
        .unwrap()
        .unwrap();
    tx.commit().await.unwrap();
    verdict
}

/// Each line's placement, by source key. Read through `to_jsonb` so a schema
/// without the placement columns reads them as absent instead of failing.
pub(crate) async fn placements(pool: &PgPool, run: Uuid) -> Vec<Placed> {
    sqlx::query_as("SELECT employee_source_key, (to_jsonb(l)->>'legal_entity_id')::uuid, (to_jsonb(l)->>'workplace_id')::uuid, (to_jsonb(l)->>'org_unit_id')::uuid FROM payroll_draft_lines l WHERE run_id=$1 ORDER BY employee_source_key")
        .bind(run).fetch_all(pool).await.unwrap()
}

/// Each line's source key and calculation status.
pub(crate) async fn statuses(pool: &PgPool, run: Uuid) -> Vec<(String, String)> {
    sqlx::query_as("SELECT employee_source_key, calculation_status FROM payroll_draft_lines WHERE run_id=$1 ORDER BY employee_source_key")
        .bind(run).fetch_all(pool).await.unwrap()
}

pub(crate) fn placed(key: &str, entity: Uuid, workplace: Uuid, unit: Option<Uuid>) -> Placed {
    (key.to_owned(), Some(entity), Some(workplace), unit)
}
