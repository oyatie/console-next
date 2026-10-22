//! The 인적사항 extras on Postgres: the stored values (the correction's current
//! values, the ledger's old values and the read), the checks that need the
//! record, and the write inside a correction's transaction after
//! `corrections::lock_employee` locked the employee row.

use console_hr_domain::personal::{
    EmergencyContact, validate_emergency_contacts, validate_group_service_start,
};
use console_hr_domain::text::parse_yyyy_mm_dd;
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use time::Date;
use uuid::Uuid;

use crate::HrError;
use crate::corrections::refusal;

/// Conservative legal basis for emergency contact processing pending counsel
/// (`DECISIONS.md` §2026-10-20; never a consent checkbox).
pub const EMERGENCY_CONTACT_BASIS: &str = "VITAL_INTEREST_PENDING_COUNSEL";

/// The items of one employee in their stored text form (the form
/// [`super::normalize`] returns).
#[derive(Debug, Default)]
pub struct PersonalRow {
    pub name_hanja: Option<String>,
    pub name_en: Option<String>,
    pub nationality: Option<String>,
    pub personal_email: Option<String>,
    pub emergency_contacts: Option<String>,
    pub photo: Option<String>,
    pub group_service_start_date: Option<String>,
}

impl PersonalRow {
    /// The stored value of an item, `None` when 미입력.
    #[must_use]
    pub fn stored(&self, field: &str) -> Option<&str> {
        match field {
            "name_hanja" => self.name_hanja.as_deref(),
            "name_en" => self.name_en.as_deref(),
            "nationality" => self.nationality.as_deref(),
            "personal_email" => self.personal_email.as_deref(),
            "emergency_contacts" => self.emergency_contacts.as_deref(),
            "photo" => self.photo.as_deref(),
            "group_service_start_date" => self.group_service_start_date.as_deref(),
            _ => None,
        }
    }
}

const LOAD: &str = "SELECT f.name_hanja, f.name_en, f.nationality, f.personal_email, \
     f.photo_upload_id::text AS photo, to_char(f.group_service_start_date, 'YYYY-MM-DD') AS group_start, \
     (SELECT jsonb_agg(jsonb_build_object( \
        'name', c.name, 'relation', c.relation, 'phone', c.phone_e164, \
        'contact_notified', c.contact_notified) \
        ORDER BY c.seq)::text \
      FROM employee_emergency_contacts c \
      WHERE c.org_id = f.org_id AND c.employee_id = f.employee_id AND c.voided_at IS NULL) AS contacts \
     FROM employee_personal_facts f WHERE f.org_id = $1 AND f.employee_id = $2";

/// The stored items; all `None` when nothing was recorded yet.
pub async fn load_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee_id: Uuid,
) -> Result<PersonalRow, HrError> {
    let Some(row) = sqlx::query(LOAD)
        .bind(org)
        .bind(employee_id)
        .fetch_optional(tx.as_mut())
        .await?
    else {
        return Ok(PersonalRow::default());
    };
    Ok(PersonalRow {
        name_hanja: row.try_get("name_hanja")?,
        name_en: row.try_get("name_en")?,
        nationality: row.try_get("nationality")?,
        personal_email: row.try_get("personal_email")?,
        emergency_contacts: row.try_get("contacts")?,
        photo: row.try_get("photo")?,
        group_service_start_date: row.try_get("group_start")?,
    })
}

/// The checks a value cannot pass on its own, run before it is applied or
/// filed: the 그룹 입사일 in force (`group`, new or stored) on or before the
/// 입사일 in force (`hire`), and a 사진 only from a confirmed upload of this
/// employee.
pub(crate) async fn check_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee_id: Uuid,
    hire: Option<Date>,
    group: Option<&str>,
    photo: Option<&str>,
) -> Result<(), HrError> {
    if let Some(start) = group.and_then(|raw| parse_yyyy_mm_dd(raw).ok()) {
        validate_group_service_start(start, hire).map_err(HrError::from_kernel)?;
    }
    let Some(upload) = photo else {
        return Ok(());
    };
    let upload = Uuid::parse_str(upload)
        .map_err(|_| HrError::validation("changes.photo must be a photo upload id"))?;
    let confirmed: Option<bool> = sqlx::query_scalar(
        "SELECT confirmed_at IS NOT NULL FROM employee_photo_uploads \
         WHERE org_id = $1 AND id = $2 AND employee_id = $3",
    )
    .bind(org)
    .bind(upload)
    .bind(employee_id)
    .fetch_optional(tx.as_mut())
    .await?;
    match confirmed {
        Some(true) => Ok(()),
        Some(false) => Err(refusal(
            StatusCode::CONFLICT,
            "photo_upload_unconfirmed",
            "the photo has not been uploaded yet; confirm the upload first",
        )),
        None => Err(refusal(
            StatusCode::NOT_FOUND,
            "photo_upload_not_found",
            "no photo upload with this id exists for this employee",
        )),
    }
}

/// `UPDATE employee_personal_facts SET <assignment>` for one employee.
macro_rules! set {
    ($assignment:literal) => {
        concat!(
            "UPDATE employee_personal_facts SET ",
            $assignment,
            ", updated_at = now() WHERE org_id = $1 AND employee_id = $2"
        )
    };
}

/// Writes normalized `(field, value)` items for the locked employee.
pub(crate) async fn write_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee_id: Uuid,
    fields: &[(&str, Option<&str>)],
    actor: Uuid,
) -> Result<(), HrError> {
    sqlx::query(
        "INSERT INTO employee_personal_facts (org_id, employee_id) VALUES ($1, $2) \
         ON CONFLICT (org_id, employee_id) DO NOTHING",
    )
    .bind(org)
    .bind(employee_id)
    .execute(tx.as_mut())
    .await?;
    for (field, value) in fields {
        if *field == "emergency_contacts" {
            write_contacts(tx, org, employee_id, actor, *value).await?;
            continue;
        }
        // One literal statement per column: a CASE over one text parameter
        // would let the planner fold `$n::uuid` / `$n::date` on a value meant
        // for another column.
        let sql = match *field {
            "name_hanja" => set!("name_hanja = $3"),
            "name_en" => set!("name_en = $3"),
            "nationality" => set!("nationality = $3"),
            "personal_email" => set!("personal_email = $3"),
            "photo" => set!("photo_upload_id = $3::uuid"),
            "group_service_start_date" => set!("group_service_start_date = $3::date"),
            other => {
                return Err(HrError::validation(format!(
                    "{other} is not a personal item"
                )));
            }
        };
        sqlx::query(sql)
            .bind(org)
            .bind(employee_id)
            .bind(*value)
            .execute(tx.as_mut())
            .await?;
    }
    Ok(())
}

/// Match against server-owned history, never evidence supplied by the caller.
/// Correction, bulk apply and request decision writers hold the employee lock.
pub(crate) async fn contact_plan(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee_id: Uuid,
    value: Option<&str>,
) -> Result<Value, HrError> {
    let contacts = super::normalize("emergency_contacts", &json!(value))?;
    let rows: Vec<EmergencyContact> = serde_json::from_str(contacts.as_deref().unwrap_or("[]"))
        .map_err(|_| HrError::validation("changes.emergency_contacts could not be stored"))?;
    let mut recorded: Vec<(Uuid, sqlx::types::Json<EmergencyContact>)> = sqlx::query_as(
        "SELECT id, jsonb_build_object('name', name, 'relation', relation, \
         'phone', phone_e164, 'contact_notified', contact_notified) \
         FROM employee_emergency_contacts WHERE org_id = $1 AND employee_id = $2 \
         ORDER BY (voided_at IS NULL) DESC, created_at DESC, id",
    )
    .bind(org)
    .bind(employee_id)
    .fetch_all(tx.as_mut())
    .await?;
    validate_emergency_contacts(
        &rows,
        &recorded
            .iter()
            .map(|(_, row)| row.0.clone())
            .collect::<Vec<_>>(),
    )
    .map_err(|error| HrError {
        code: error.code.unwrap_or("validation"),
        ..HrError::from_kernel(error)
    })?;
    let plan: Vec<Value> = rows
        .into_iter()
        .map(|row| {
            let id = recorded
                .iter()
                .position(|(_, old)| old.0 == row)
                .map(|index| recorded.remove(index).0);
            json!({"id": id, "contact": row})
        })
        .collect();
    Ok(json!(plan))
}

async fn write_contacts(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee_id: Uuid,
    actor: Uuid,
    json: Option<&str>,
) -> Result<(), HrError> {
    let plan = contact_plan(tx, org, employee_id, json).await?;
    // Free the unique live sequence slots before restoring matches in their requested order.
    sqlx::query(
        "UPDATE employee_emergency_contacts c SET voided_at = now() \
         WHERE c.org_id = $1 AND c.employee_id = $2 AND c.voided_at IS NULL \
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS r(v, n) \
                         WHERE c.id = (r.v->>'id')::uuid AND c.seq = r.n)",
    )
    .bind(org)
    .bind(employee_id)
    .bind(&plan)
    .execute(tx.as_mut())
    .await?;
    sqlx::query(
        "UPDATE employee_emergency_contacts c SET voided_at = NULL, seq = r.n::smallint \
         FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS r(v, n) \
         WHERE c.org_id = $1 AND c.employee_id = $2 AND c.id = (r.v->>'id')::uuid",
    )
    .bind(org)
    .bind(employee_id)
    .bind(&plan)
    .execute(tx.as_mut())
    .await?;
    sqlx::query(
        "INSERT INTO employee_emergency_contacts (org_id, employee_id, seq, name, relation, \
         phone_e164, created_by, basis, contact_notified) \
         SELECT $1, $2, r.n, r.v->'contact'->>'name', r.v->'contact'->>'relation', \
         r.v->'contact'->>'phone', $4, $5, true \
         FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS r(v, n) \
         WHERE r.v->>'id' IS NULL",
    )
    .bind(org)
    .bind(employee_id)
    .bind(&plan)
    .bind(actor)
    .bind(EMERGENCY_CONTACT_BASIS)
    .execute(tx.as_mut())
    .await?;
    sqlx::query(
        "UPDATE employee_personal_facts SET updated_at = now() WHERE org_id = $1 AND employee_id = $2",
    )
    .bind(org)
    .bind(employee_id)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}
