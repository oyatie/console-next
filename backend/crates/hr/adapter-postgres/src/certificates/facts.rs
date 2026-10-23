// SPDX-License-Identifier: LicenseRef-Proprietary
//! Take the minimal snapshot while holding the subject against concurrent changes.
use super::{IssueCertificateRequest, not_found, refused};
use crate::HrError;
use console_platform_authz::Principal;
use console_platform_db::settings_read::resolve_in_tx;
use console_settings_domain::{SettingKey, SettingValue};
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use time::{Date, Month, OffsetDateTime};

fn missing() -> HrError {
    refused(
        http::StatusCode::CONFLICT,
        "certificate_facts_missing",
        "a requested employee fact is not recorded; correct the personnel card first",
    )
}
fn recorded(value: Option<String>) -> Result<String, HrError> {
    value.filter(|v| !v.trim().is_empty()).ok_or_else(missing)
}
fn anniversary(date: Date, years: i32) -> Result<Date, HrError> {
    let year = date.year().checked_add(years).ok_or_else(missing)?;
    Date::from_calendar_date(year, date.month(), date.day())
        .or_else(|_| Date::from_calendar_date(year, Month::February, 28))
        .map_err(|_| missing())
}
pub(super) async fn snapshot(
    tx: &mut Transaction<'_, Postgres>,
    p: &Principal,
    b: &IssueCertificateRequest,
) -> Result<(uuid::Uuid, Value), HrError> {
    let row=sqlx::query(concat!("SELECT COALESCE(console_employee_facts(e.org_id,e.id)->>'legal_name',e.name) AS name,e.hire_on,e.exit_on,e.employment_status,e.voided_at,e.job,e.position,CASE WHEN console_employee_facts(e.org_id,e.id) ? 'birth_date' THEN console_employee_facts(e.org_id,e.id)->>'birth_date' ELSE e.birth_date::TEXT END AS birth, p.base_pay_won::TEXT AS wage,p.pay_unit,ea.legal_entity_id,le.name AS issuer FROM employees e LEFT JOIN employee_employment_profiles p ON p.org_id=e.org_id AND p.employee_id=e.id ",crate::assignment_lateral!()," LEFT JOIN LATERAL (SELECT r.name FROM legal_entity_revisions r WHERE r.org_id=e.org_id AND r.legal_entity_id=ea.legal_entity_id AND r.effective_from<=(now() AT TIME ZONE 'Asia/Seoul')::date ORDER BY r.effective_from DESC,r.version DESC LIMIT 1) le ON TRUE WHERE e.org_id=$1 AND e.id=$2 FOR SHARE OF e"))
        .bind(p.org_id.as_uuid()).bind(b.employee_id).fetch_optional(tx.as_mut()).await?.ok_or_else(not_found)?;
    super::access::person(tx, p, "certificate_issue", b.employee_id).await?;
    let entity = row
        .try_get::<Option<uuid::Uuid>, _>("legal_entity_id")?
        .ok_or_else(missing)?;
    let issuer = recorded(row.try_get("issuer")?)?;
    let now: OffsetDateTime = sqlx::query_scalar("SELECT now()")
        .fetch_one(tx.as_mut())
        .await?;
    let today = now.to_offset(time::macros::offset!(+9)).date();
    let hire: Date = row
        .try_get::<Option<Date>, _>("hire_on")?
        .ok_or_else(missing)?;
    let exit: Option<Date> = row.try_get("exit_on")?;
    let status: String = row.try_get("employment_status")?;
    let voided: Option<OffsetDateTime> = row.try_get("voided_at")?;
    if voided.is_some()
        || hire > today
        || !matches!(status.as_str(), "ACTIVE" | "ON_LEAVE" | "EXITED")
        || (b.kind == "EMPLOYMENT" && status == "EXITED")
        || (b.kind == "EXIT" && status != "EXITED")
    {
        return Err(refused(
            http::StatusCode::CONFLICT,
            "certificate_ineligible",
            "employee status does not support the requested certificate",
        ));
    }
    if status == "EXITED" {
        let end = exit.ok_or_else(missing)?;
        if end > today || end < hire {
            return Err(missing());
        }
        let key = SettingKey::RetentionLaborEmployeeRegister;
        let settings = resolve_in_tx(tx.as_mut(), p.org_id, &[key], Some(entity), now).await?;
        let years = match settings
            .get(&key)
            .and_then(|r| r.as_ref().ok())
            .map(|r| r.value)
        {
            Some(SettingValue::Int(years)) => i32::try_from(years).map_err(|_| missing())?,
            _ => return Err(missing()),
        };
        if today > anniversary(end, years)? {
            return Err(refused(
                http::StatusCode::CONFLICT,
                "certificate_retention_expired",
                "employee record is outside its configured retention window",
            ));
        }
    }
    let mut facts = json!({"name":row.try_get::<String,_>("name")?,"issuer":issuer});
    for field in &b.items {
        facts[field] = match field.as_str() {
            "period" => {
                json!({"from":hire.to_string(),"to":if status=="EXITED" {exit.ok_or_else(missing)?.to_string()} else {today.to_string()}})
            }
            "duty" => json!(recorded(row.try_get("job")?)?),
            "position" => json!(recorded(row.try_get("position")?)?),
            "birth" => json!(recorded(row.try_get("birth")?)?),
            "wage" => {
                json!({"won":recorded(row.try_get("wage")?)?,"unit":recorded(row.try_get("pay_unit")?)?})
            }
            _ => return Err(super::invalid("unknown requested fact")),
        };
    }
    Ok((entity, facts))
}
#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    #[test]
    fn retention_uses_calendar_anniversaries_including_leap_day() {
        assert_eq!(
            anniversary(time::macros::date!(2024 - 02 - 29), 3).unwrap(),
            time::macros::date!(2027 - 02 - 28)
        );
        assert_eq!(
            anniversary(time::macros::date!(2024 - 02 - 29), 4).unwrap(),
            time::macros::date!(2028 - 02 - 29)
        );
        assert_eq!(
            anniversary(time::macros::date!(2020 - 10 - 21), 3).unwrap(),
            time::macros::date!(2023 - 10 - 21)
        );
    }
}
