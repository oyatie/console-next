//! 약정휴일 writes: preview, add, 사용 중지.

use console_attendance_application::CallerScope;
use console_attendance_application::calendar::{
    ContractualHoliday, HolidayInput, HolidayOverlap, HolidayPreview, HolidayRetireInput,
};
use console_attendance_application::schedule::Refusal;
use console_attendance_domain::schedule::Level;
use console_kernel_core::OrgId;
use console_platform_db::{with_audits, with_org_conn};
use serde_json::json;
use sqlx::{Postgres, Transaction};
use time::Date;
use uuid::Uuid;

use super::org::{load_org, load_roster};
use super::preview::{authorize_scope, branch_of, reach};
use super::universe::{Universe, today_kst};
use super::{
    ScheduleStoreError, audit, claim_key, closed_months, codes, fingerprint, lock_closed_months,
    month_label,
};
use crate::PgAttendanceStore;

use super::holidays::{load_contractual, named};

fn level_of(scope_kind: &str) -> Result<Level, ScheduleStoreError> {
    match scope_kind {
        "LEGAL_ENTITY" => Ok(Level::LegalEntity),
        "WORKPLACE" => Ok(Level::Workplace),
        _ => Err(ScheduleStoreError::Invalid(codes::HOLIDAY_RULE_INVALID)),
    }
}

fn check_input(input: &HolidayInput) -> Result<Date, ScheduleStoreError> {
    let text_ok = |s: &str, max: usize| !s.trim().is_empty() && s.trim().chars().count() <= max;
    let enums_ok = matches!(
        input.basis_kind.as_str(),
        "WORK_RULES" | "COLLECTIVE_AGREEMENT"
    );
    if !text_ok(&input.name, 40)
        || !text_ok(&input.basis_ref, 100)
        || !enums_ok
        || !(2000..=2100).contains(&input.start_year)
    {
        return Err(ScheduleStoreError::Invalid(codes::HOLIDAY_RULE_INVALID));
    }
    level_of(&input.scope_kind)?;
    input.first_date().map_err(ScheduleStoreError::Invalid)
}

async fn plan(
    tx: &mut Transaction<'_, Postgres>,
    caller: &CallerScope,
    input: &HolidayInput,
) -> Result<(Universe, HolidayPreview), ScheduleStoreError> {
    let first = check_input(input)?;
    let level = level_of(&input.scope_kind)?;
    let org = load_org(tx).await?;
    let u = Universe::load(tx, org, (first.year(), first.year() + 1)).await?;
    let roster = load_roster(tx, first, None).await?;
    authorize_scope(caller, &u, &roster, level, input.scope_id)?;
    let reached: Vec<_> = roster
        .iter()
        .filter(|p| reach(&u, p, level, input.scope_id).is_some())
        .collect();
    let branches: Vec<_> = reached.iter().map(|p| branch_of(&u, p)).collect();
    let month = (first.year(), u8::from(first.month()));
    let closed: Vec<String> = closed_months(tx, &branches)
        .await?
        .into_iter()
        .filter(|m| *m >= month)
        .map(month_label)
        .collect();
    let mut refusals = Vec::new();
    if closed.contains(&month_label(month)) {
        refusals.push(Refusal {
            code: codes::HOLIDAY_MONTH_CLOSED,
            target: None,
        });
    }
    let overlaps_public = [first.year(), first.year() + 1]
        .into_iter()
        .filter_map(|y| {
            let d = match (input.on_date, input.month, input.day) {
                (Some(d), _, _) => (d.year() == y).then_some(d),
                (None, Some(m), Some(d)) => {
                    console_attendance_application::calendar::yearly_date(y, m, d)
                }
                _ => None,
            }?;
            u.public.get(&d).map(|h| HolidayOverlap {
                date: d,
                name: h.name.clone(),
            })
        })
        .collect();
    let people = i64::try_from(reached.len()).unwrap_or(i64::MAX);
    Ok((
        u,
        HolidayPreview {
            people,
            first_date: first,
            closed_months: closed,
            overlaps_public,
            refusals,
        },
    ))
}

impl PgAttendanceStore {
    pub async fn preview_holiday(
        &self,
        caller: &CallerScope,
        input: HolidayInput,
    ) -> Result<HolidayPreview, ScheduleStoreError> {
        let caller = caller.clone();
        with_org_conn::<_, _, ScheduleStoreError>(
            &self.pool,
            OrgId::from_uuid(caller.org_id),
            move |tx| Box::pin(async move { Ok(plan(tx, &caller, &input).await?.1) }),
        )
        .await
    }

    pub async fn create_holiday(
        &self,
        caller: &CallerScope,
        key: &str,
        input: HolidayInput,
    ) -> Result<(ContractualHoliday, bool), ScheduleStoreError> {
        let print = fingerprint(&json!([
            input.name.trim(),
            input.rule_kind,
            input.on_date.map(|d| d.to_string()),
            input.month,
            input.day,
            input.paid,
            input.scope_kind,
            input.scope_id,
            input.basis_kind,
            input.basis_ref.trim(),
            input.start_year
        ]));
        let (caller, key) = (caller.clone(), key.to_owned());
        with_audits::<_, _, ScheduleStoreError>(&self.pool, OrgId::from_uuid(caller.org_id), move |tx| {
            Box::pin(async move {
                let key = claim_key(tx, &caller, &key).await?;
                lock_closed_months(tx, caller.org_id).await?;
                let (u, preview) = plan(tx, &caller, &input).await?;
                let prior: Option<(Uuid, String)> = sqlx::query_as("SELECT id, request_fingerprint FROM attendance_contractual_holidays WHERE idempotency_key = $1")
                    .bind(&key).fetch_optional(tx.as_mut()).await?;
                let id = match prior {
                    Some((_, f)) if f != print => return Err(ScheduleStoreError::Conflict(codes::IDEMPOTENCY_KEY_REUSED)),
                    Some((id, _)) => Some(id),
                    None => None,
                };
                if id.is_none() && !preview.refusals.is_empty() {
                    return Err(ScheduleStoreError::Conflict(codes::HOLIDAY_MONTH_CLOSED));
                }
                let (id, fresh) = match id {
                    Some(id) => (id, false),
                    None => {
                        let id = Uuid::new_v4();
                        let col = if input.scope_kind == "LEGAL_ENTITY" { "legal_entity_id" } else { "workplace_id" };
                        sqlx::query(sqlx::AssertSqlSafe(format!(
                            "INSERT INTO attendance_contractual_holidays (id, org_id, name, rule_kind, on_date, month, day, paid, scope_kind, {col}, \
                             basis_kind, basis_ref, start_year, created_by, idempotency_key, request_fingerprint) \
                             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)")))
                            .bind(id).bind(caller.org_id).bind(input.name.trim()).bind(&input.rule_kind).bind(input.on_date)
                            .bind(input.month).bind(input.day).bind(input.paid).bind(&input.scope_kind).bind(input.scope_id)
                            .bind(&input.basis_kind).bind(input.basis_ref.trim()).bind(input.start_year).bind(caller.user_id)
                            .bind(&key).bind(&print).execute(tx.as_mut()).await?;
                        (id, true)
                    }
                };
                let events = if fresh {
                    vec![audit(&caller, "attendance.holiday.create", "attendance_contractual_holiday", id, json!({"name": input.name.trim()}))?]
                } else {
                    vec![]
                };
                let row = load_contractual(tx).await?.into_iter().find(|h| h.id == id).ok_or(ScheduleStoreError::NotFound(codes::HOLIDAY_NOT_FOUND))?;
                Ok(((named(&u, row), fresh), events))
            })
        })
        .await
    }

    pub async fn retire_holiday(
        &self,
        caller: &CallerScope,
        id: Uuid,
        input: HolidayRetireInput,
    ) -> Result<ContractualHoliday, ScheduleStoreError> {
        let caller = caller.clone();
        with_audits::<_, _, ScheduleStoreError>(
            &self.pool,
            OrgId::from_uuid(caller.org_id),
            move |tx| {
                Box::pin(async move {
                    let h = load_contractual(tx)
                        .await?
                        .into_iter()
                        .find(|h| h.id == id)
                        .ok_or(ScheduleStoreError::NotFound(codes::HOLIDAY_NOT_FOUND))?;
                    let org = load_org(tx).await?;
                    let today = today_kst();
                    let u = Universe::load(tx, org, (today.year(), today.year())).await?;
                    authorize_scope(&caller, &u, &[], level_of(&h.scope_kind)?, h.scope_id)?;
                    let from = input.from_year;
                    if i32::from(from) < today.year()
                        || from < h.start_year
                        || h.end_year.is_some_and(|e| from > e + 1)
                    {
                        return Err(ScheduleStoreError::Invalid(
                            codes::HOLIDAY_RETIRE_YEAR_INVALID,
                        ));
                    }
                    sqlx::query(
                        "UPDATE attendance_contractual_holidays SET end_year = $2 WHERE id = $1",
                    )
                    .bind(id)
                    .bind(from - 1)
                    .execute(tx.as_mut())
                    .await?;
                    let event = audit(
                        &caller,
                        "attendance.holiday.retire",
                        "attendance_contractual_holiday",
                        id,
                        json!({"from_year": from}),
                    )?;
                    let row = load_contractual(tx)
                        .await?
                        .into_iter()
                        .find(|x| x.id == id)
                        .ok_or(ScheduleStoreError::NotFound(codes::HOLIDAY_NOT_FOUND))?;
                    Ok((named(&u, row), vec![event]))
                })
            },
        )
        .await
    }
}
