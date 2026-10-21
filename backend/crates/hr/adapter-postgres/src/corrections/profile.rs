//! Corrections of the employment-profile fields (phone, employment type, pay
//! and its unit, 수습 종료일). The columns and their console_rt UPDATE grant
//! come from the EMP-MODEL migration; `employee_employment_profiles` is not a
//! canonical object table, so the HR adapter writes it directly.

use http::StatusCode;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

use super::refusal;
use crate::HrError;

pub(crate) const PROFILE_FIELDS: [&str; 5] = [
    "phone",
    "employment_type",
    "base_pay",
    "pay_unit",
    "probation_end_date",
];

/// Current profile values, `None` when the employee has no profile row (an
/// imported record).
pub(crate) struct ProfileValues {
    /// `None`: not recorded (an imported profile, MR-7).
    pub phone_e164: Option<String>,
    pub employment_type: Option<String>,
    pub base_pay: Option<String>,
    pub pay_unit: Option<String>,
    pub probation_end_date: Option<String>,
    pub probation_confirmed: bool,
}

pub(crate) fn profile_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<Option<ProfileValues>, HrError> {
    let has_profile: bool = row.try_get("has_profile")?;
    if !has_profile {
        return Ok(None);
    }
    Ok(Some(ProfileValues {
        phone_e164: row.try_get("phone_e164")?,
        employment_type: row.try_get("employment_type")?,
        base_pay: row.try_get("base_pay")?,
        pay_unit: row.try_get("pay_unit")?,
        probation_end_date: row.try_get("probation_end_date")?,
        probation_confirmed: row.try_get("probation_confirmed")?,
    }))
}

impl ProfileValues {
    pub(crate) fn get(&self, field: &str) -> Option<&str> {
        match field {
            "phone" => self.phone_e164.as_deref(),
            "employment_type" => self.employment_type.as_deref(),
            "base_pay" => self.base_pay.as_deref(),
            "pay_unit" => self.pay_unit.as_deref(),
            "probation_end_date" => self.probation_end_date.as_deref(),
            _ => None,
        }
    }
}

/// Writes the corrected profile values. `value_of` is `None` for a field not
/// in the correction and `Some(None)` for one cleared (only the 수습 종료일).
/// base_pay also fills base_pay_won once a pay unit is (or becomes) recorded
/// (the E5 pair).
pub(crate) async fn update_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee_id: Uuid,
    has_profile: bool,
    value_of: impl Fn(&str) -> Option<Option<String>>,
) -> Result<(), HrError> {
    if !has_profile {
        return Err(refusal(
            StatusCode::CONFLICT,
            "employee_profile_missing",
            "this employee has no employment profile to correct",
        ));
    }
    let set = |name: &str| value_of(name).flatten();
    let probation = value_of("probation_end_date");
    sqlx::query(
        "UPDATE employee_employment_profiles SET phone_e164 = COALESCE($3, phone_e164), \
         employment_type = COALESCE($4, employment_type), \
         base_pay = COALESCE($5::numeric, base_pay), \
         pay_unit = COALESCE($6, pay_unit), \
         base_pay_won = CASE WHEN COALESCE($6, pay_unit) IS NULL THEN base_pay_won \
                             ELSE COALESCE($5::bigint, base_pay_won) END, \
         probation_end_date = CASE WHEN $7 THEN $8::date ELSE probation_end_date END \
         WHERE org_id = $1 AND employee_id = $2",
    )
    .bind(org)
    .bind(employee_id)
    .bind(set("phone"))
    .bind(set("employment_type"))
    .bind(set("base_pay"))
    .bind(set("pay_unit"))
    .bind(probation.is_some())
    .bind(probation.flatten())
    .execute(tx.as_mut())
    .await?;
    Ok(())
}
