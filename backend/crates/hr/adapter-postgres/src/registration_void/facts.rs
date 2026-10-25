//! What a void decision reads inside its transaction: the tenant phase, the
//! locked record and its work-record fact, and the registry values.

use console_hr_domain::text::parse_yyyy_mm_dd;
use console_kernel_core::tenant_phase::admit_write;
use console_kernel_core::{KernelError, OrgId, TenantPhase, WriteClass};
use console_settings_adapter_postgres::resolve_in_tx;
use console_settings_domain::{SettingKey, SettingValue};
use sqlx::{Postgres, Transaction};
use time::{Date, OffsetDateTime};
use uuid::Uuid;

use crate::HrError;
use crate::lifecycle::title_reason::coded;

/// Admits a SETUP delete (`SetupVoid`) or a void (`Operational`) in the
/// current phase, read `FOR SHARE` so a concurrent 운영 시작 serialises.
/// Returns the `ChangeMode` string the write is recorded under.
pub(super) async fn admit(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    class: WriteClass,
) -> Result<&'static str, HrError> {
    let phase: Option<String> =
        sqlx::query_scalar("SELECT phase FROM tenant_phase WHERE org_id = $1 FOR SHARE")
            .bind(org)
            .fetch_optional(tx.as_mut())
            .await?;
    admit_write(TenantPhase::from_db(phase.as_deref()), class)
        .map(|mode| mode.as_str())
        .map_err(coded)
}

/// The locked record a void reads.
#[derive(sqlx::FromRow)]
pub(super) struct Locked {
    pub status: String,
    pub registered_on: Date,
    pub updated_at: OffsetDateTime,
    pub employee_number: Option<String>,
    /// The legacy TEXT 퇴직일 as stored; [`Locked::exit_on`] parses it.
    exit_date: Option<String>,
    pub has_work_records: bool,
    pub recorded_hire_date: Option<String>,
}

impl Locked {
    pub(super) fn exit_on(&self) -> Option<Date> {
        self.exit_date
            .as_deref()
            .and_then(|raw| parse_yyyy_mm_dd(raw.trim()).ok())
    }
}

/// Locks the (visible, so not yet voided) record and reads its facts.
// the work records are the four tables that prove a person worked
// today (exit case, applied 발령 other than the ONBOARD, attendance, payroll
// line); add a table here when a module starts recording work elsewhere.
pub(super) async fn lock(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee_id: Uuid,
) -> Result<Locked, HrError> {
    sqlx::query_as(
        "SELECT e.employment_status AS status, \
               (e.created_at AT TIME ZONE 'Asia/Seoul')::date AS registered_on, \
               e.updated_at, e.employee_number, e.exit_date, e.hire_on::text AS recorded_hire_date, \
               EXISTS (SELECT 1 FROM employee_exit_cases c \
                        WHERE c.org_id = e.org_id AND c.employee_id = e.id) \
               OR EXISTS (SELECT 1 FROM employee_lifecycle_events l \
                           WHERE l.org_id = e.org_id AND l.employee_id = e.id \
                             AND l.state = 'APPLIED' AND l.event_type <> 'ONBOARD') \
               OR EXISTS (SELECT 1 FROM employee_attendance_records a \
                           WHERE a.org_id = e.org_id AND a.employee_id = e.id) \
               OR EXISTS (SELECT 1 FROM payroll_draft_lines p \
                           WHERE p.org_id = e.org_id AND p.employee_id = e.id) AS has_work_records \
             FROM employees e WHERE e.org_id = $1 AND e.id = $2 FOR UPDATE OF e",
    )
    .bind(org)
    .bind(employee_id)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| {
        HrError::from_kernel(KernelError::not_found(
            "employee was not found in this organization",
        ))
    })
}

/// 409 when the record changed since the caller read it.
pub(super) fn check_version(locked: &Locked, expected_updated_at: &str) -> Result<(), HrError> {
    let expected = OffsetDateTime::parse(
        expected_updated_at.trim(),
        &time::format_description::well_known::Rfc3339,
    )
    .map_err(|_| HrError::validation("expected_updated_at must be an RFC 3339 timestamp"))?;
    if locked.updated_at == expected {
        Ok(())
    } else {
        Err(HrError::from_kernel(KernelError::conflict(
            "employee changed since it was read; reload before cancelling the registration",
        )))
    }
}

/// Today in Asia/Seoul, from the transaction's clock.
pub(super) async fn today_kst(tx: &mut Transaction<'_, Postgres>) -> Result<Date, HrError> {
    Ok(
        sqlx::query_scalar("SELECT (now() AT TIME ZONE 'Asia/Seoul')::date")
            .fetch_one(tx.as_mut())
            .await?,
    )
}

/// One integer registry value for the tenant.
pub(super) async fn int_setting(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    key: SettingKey,
) -> Result<i64, HrError> {
    let settings = resolve_in_tx(
        tx.as_mut(),
        OrgId::from_uuid(org),
        &[key],
        None,
        OffsetDateTime::now_utc(),
    )
    .await
    .map_err(coded)?;
    match settings.get(&key) {
        Some(Ok(resolved)) => match resolved.value {
            SettingValue::Int(value) => Ok(value),
            _ => Err(HrError::internal(format!(
                "setting {} is not a number",
                key.as_str()
            ))),
        },
        _ => Err(HrError::internal(format!(
            "setting {} did not resolve",
            key.as_str()
        ))),
    }
}
