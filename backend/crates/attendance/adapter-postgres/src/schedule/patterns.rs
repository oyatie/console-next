//! 근무 유형: list, add, 사용 중지.

use console_attendance_application::CallerScope;
use console_attendance_application::schedule::{Items, PatternInput, PatternRead, StoredSpec};
use console_attendance_domain::schedule::{PatternSpec, ScheduleRefusal, winner};
use console_kernel_core::OrgId;
use console_platform_db::{with_audits, with_org_conn};
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

use super::org::{load_org, load_roster};
use super::preview::visible;
use super::universe::{Universe, today_kst};
use super::{ScheduleStoreError, audit, claim_key, codes, fingerprint};
use crate::PgAttendanceStore;

const SELECT: &str = "SELECT p.id, p.name, p.spec, p.weekly_minutes, p.cycle_days, p.status, p.created_at, \
     COALESCE(u.display_name, '') AS created_by_name, \
     (SELECT count(*) FROM attendance_schedule_layers l WHERE l.pattern_id = p.id AND l.status = 'ACTIVE' \
        AND (l.effective_to IS NULL OR l.effective_to > $1)) AS layers_active \
     FROM attendance_work_patterns p LEFT JOIN users u ON u.id = p.created_by AND u.org_id = p.org_id";

/// Turns the wire input into a validated spec.
///
/// # Errors
/// `regime_not_supported_yet` for 탄력 · 선택 · 간주 · 재량, a rule refusal, or
/// `pattern_input_invalid` for a malformed body.
pub fn parse_input(input: &PatternInput) -> Result<StoredSpec, ScheduleStoreError> {
    if matches!(
        input.kind.as_str(),
        "FLEXIBLE" | "SELECTIVE" | "DEEMED" | "DISCRETIONARY"
    ) {
        return Err(ScheduleRefusal::RegimeNotSupportedYet.into());
    }
    let raw = json!({
        "kind": input.kind,
        "days": input.days.clone().unwrap_or(Value::Null),
        "slots": input.slots.clone().unwrap_or(Value::Null),
        "start_choices": input.start_choices.clone().unwrap_or_default(),
    });
    let pattern: PatternSpec = serde_json::from_value(raw)
        .map_err(|_| ScheduleStoreError::Invalid(codes::PATTERN_INPUT_INVALID))?;
    pattern.validate()?;
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 60 {
        return Err(ScheduleStoreError::Invalid(codes::PATTERN_INPUT_INVALID));
    }
    Ok(StoredSpec {
        pattern,
        holiday_rule: input.holiday_rule.unwrap_or_default(),
    })
}

fn read_row(
    row: &sqlx::postgres::PgRow,
    people_today: i64,
) -> Result<PatternRead, ScheduleStoreError> {
    let spec: Value = row.try_get("spec")?;
    let spec: StoredSpec =
        serde_json::from_value(spec).map_err(|_| ScheduleStoreError::Corrupt("spec"))?;
    let derived = spec
        .pattern
        .validate()
        .map_err(|_| ScheduleStoreError::Corrupt("spec"))?;
    Ok(PatternRead {
        id: row.try_get("id")?,
        name: row.try_get("name")?,
        spec,
        weekly_minutes: row.try_get("weekly_minutes")?,
        cycle_days: row.try_get("cycle_days")?,
        night_work: derived.night_work,
        status: row.try_get("status")?,
        people_today,
        layers_active: row.try_get("layers_active")?,
        created_at: row.try_get("created_at")?,
        created_by_name: row.try_get("created_by_name")?,
    })
}

async fn one(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<PatternRead, ScheduleStoreError> {
    let row = sqlx::query(sqlx::AssertSqlSafe(format!("{SELECT} WHERE p.id = $2")))
        .bind(today_kst())
        .bind(id)
        .fetch_optional(tx.as_mut())
        .await?
        .ok_or(ScheduleStoreError::NotFound(codes::PATTERN_NOT_FOUND))?;
    read_row(&row, 0)
}

impl PgAttendanceStore {
    pub async fn list_patterns(
        &self,
        caller: &CallerScope,
        include_retired: bool,
    ) -> Result<Items<PatternRead>, ScheduleStoreError> {
        let caller = caller.clone();
        with_org_conn::<_, _, ScheduleStoreError>(
            &self.pool,
            OrgId::from_uuid(caller.org_id),
            move |tx| {
                Box::pin(async move {
                    let today = today_kst();
                    let org = load_org(tx).await?;
                    let u = Universe::load(tx, org, (today.year(), today.year())).await?;
                    let roster = load_roster(tx, today, None).await?;
                    let mut counts = std::collections::HashMap::<Uuid, i64>::new();
                    for p in roster.iter().filter(|p| visible(&caller, &u, p)) {
                        if let Some(w) = winner(&u.layers_for(p), today) {
                            *counts.entry(w.pattern_id).or_default() += 1;
                        }
                    }
                    let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
                        "{SELECT} WHERE $2 OR p.status = 'ACTIVE' ORDER BY p.status, p.name"
                    )))
                    .bind(today)
                    .bind(include_retired)
                    .fetch_all(tx.as_mut())
                    .await?;
                    let items = rows
                        .iter()
                        .map(|r| {
                            let id: Uuid = r.try_get("id")?;
                            read_row(r, counts.get(&id).copied().unwrap_or(0))
                        })
                        .collect::<Result<_, ScheduleStoreError>>()?;
                    Ok(Items { items })
                })
            },
        )
        .await
    }

    pub async fn create_pattern(
        &self,
        caller: &CallerScope,
        key: &str,
        input: PatternInput,
    ) -> Result<(PatternRead, bool), ScheduleStoreError> {
        let spec = parse_input(&input)?;
        let derived = spec.pattern.validate()?;
        let name = input.name.trim().to_owned();
        let body = json!({"name": name, "spec": spec});
        let print = fingerprint(&body);
        let (caller, key) = (caller.clone(), key.to_owned());
        with_audits::<_, _, ScheduleStoreError>(&self.pool, OrgId::from_uuid(caller.org_id), move |tx| {
            Box::pin(async move {
                let key = claim_key(tx, &caller, &key).await?;
                let prior: Option<(Uuid, String)> = sqlx::query_as(
                    "SELECT id, request_fingerprint FROM attendance_work_patterns WHERE idempotency_key = $1",
                )
                .bind(&key)
                .fetch_optional(tx.as_mut())
                .await?;
                if let Some((id, f)) = prior {
                    if f != print {
                        return Err(ScheduleStoreError::Conflict(codes::IDEMPOTENCY_KEY_REUSED));
                    }
                    return Ok(((one(tx, id).await?, false), vec![]));
                }
                let taken: bool = sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM attendance_work_patterns WHERE status = 'ACTIVE' AND lower(btrim(name)) = lower($1))",
                )
                .bind(&name)
                .fetch_one(tx.as_mut())
                .await?;
                if taken {
                    return Err(ScheduleStoreError::Conflict(codes::PATTERN_NAME_TAKEN));
                }
                let id = Uuid::new_v4();
                sqlx::query(
                    "INSERT INTO attendance_work_patterns (id, org_id, name, kind, spec, weekly_minutes, cycle_days, \
                     created_by, idempotency_key, request_fingerprint) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
                )
                .bind(id)
                .bind(caller.org_id)
                .bind(&name)
                .bind(spec.pattern.kind())
                .bind(serde_json::to_value(&spec).map_err(|_| ScheduleStoreError::Corrupt("spec"))?)
                .bind(i32::try_from(derived.weekly_minutes).unwrap_or(i32::MAX))
                .bind(i16::try_from(derived.cycle_days).unwrap_or(i16::MAX))
                .bind(caller.user_id)
                .bind(&key)
                .bind(&print)
                .execute(tx.as_mut())
                .await?;
                let event = audit(&caller, "attendance.pattern.create", "attendance_work_pattern", id, json!({"name": name}))?;
                Ok(((one(tx, id).await?, true), vec![event]))
            })
        })
        .await
    }

    pub async fn retire_pattern(
        &self,
        caller: &CallerScope,
        id: Uuid,
    ) -> Result<PatternRead, ScheduleStoreError> {
        let caller = caller.clone();
        with_audits::<_, _, ScheduleStoreError>(&self.pool, OrgId::from_uuid(caller.org_id), move |tx| {
            Box::pin(async move {
                let status: Option<String> =
                    sqlx::query_scalar("SELECT status FROM attendance_work_patterns WHERE id = $1 FOR UPDATE")
                        .bind(id)
                        .fetch_optional(tx.as_mut())
                        .await?;
                match status.as_deref() {
                    None => return Err(ScheduleStoreError::NotFound(codes::PATTERN_NOT_FOUND)),
                    Some("RETIRED") => return Ok((one(tx, id).await?, vec![])),
                    Some(_) => {}
                }
                let today = today_kst();
                let in_use: bool = sqlx::query_scalar(IN_USE_SQL).bind(id).bind(today).fetch_one(tx.as_mut()).await?;
                if in_use {
                    return Err(ScheduleRefusal::PatternInUse.into());
                }
                sqlx::query(
                    "UPDATE attendance_work_patterns SET status = 'RETIRED', retired_at = now(), retired_by = $2 WHERE id = $1",
                )
                .bind(id)
                .bind(caller.user_id)
                .execute(tx.as_mut())
                .await?;
                let event = audit(&caller, "attendance.pattern.retire", "attendance_work_pattern", id, json!({}))?;
                Ok((one(tx, id).await?, vec![event]))
            })
        })
        .await
    }
}

/// A layer of this pattern still decides some day from today on: it is not
/// over, and no later open-ended layer at its scope has already replaced it.
const IN_USE_SQL: &str = "SELECT EXISTS (SELECT 1 FROM attendance_schedule_layers l \
     WHERE l.pattern_id = $1 AND l.status = 'ACTIVE' AND (l.effective_to IS NULL OR l.effective_to > $2) \
       AND NOT EXISTS (SELECT 1 FROM attendance_schedule_layers n WHERE n.status = 'ACTIVE' \
         AND n.scope_kind = l.scope_kind \
         AND COALESCE(n.legal_entity_id, n.workplace_id, n.org_unit_id, n.crew_id, n.employee_id) \
           = COALESCE(l.legal_entity_id, l.workplace_id, l.org_unit_id, l.crew_id, l.employee_id) \
         AND n.effective_from > l.effective_from AND n.effective_from <= $2 AND n.effective_to IS NULL))";
