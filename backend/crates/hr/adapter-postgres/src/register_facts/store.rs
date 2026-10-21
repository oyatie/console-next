//! The register items on Postgres: the stored values (the correction's
//! current values, the ledger's old values and the read), the checks that
//! need the record, and the write inside a correction's transaction after
//! `corrections::lock_employee` locked the employee row.

use console_kernel_core::OrgId;
use console_settings_adapter_postgres::validate_reason_in_tx;
use console_settings_domain::code_lists::{ReasonDomain, is_tenant_code};
use http::StatusCode;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

use super::exit_reason::exit_reason_code_sql;
use crate::HrError;
use crate::corrections::refusal;

/// The register items of one employee in their stored text form (the form
/// [`super::normalize`] returns); the address and the career list are JSON
/// text, the career list `None` while 미입력 and `[]` for 경력 없음.
#[derive(Debug, Default)]
pub struct RegisterRow {
    pub sex: Option<String>,
    pub address: Option<String>,
    pub careers: Option<String>,
    pub exit_reason_code: Option<String>,
    pub exit_reason_label: Option<String>,
    pub register_note: Option<String>,
}

impl RegisterRow {
    /// The stored value of a register item, `None` when 미입력.
    #[must_use]
    pub fn stored(&self, field: &str) -> Option<&str> {
        match field {
            "sex" => self.sex.as_deref(),
            "address" => self.address.as_deref(),
            "careers" => self.careers.as_deref(),
            "exit_reason" => self.exit_reason_code.as_deref(),
            "register_note" => self.register_note.as_deref(),
            _ => None,
        }
    }
}

// The 퇴직 사유 is the live exit case's when its report gave one.
const LOAD: &str = concat!(
    "SELECT f.sex, x.code AS exit_reason_code, f.register_note, \
     (SELECT (to_jsonb(a) - '{org_id,id,employee_id,created_by,created_at}'::text[])::text \
       FROM employee_addresses a WHERE a.org_id = f.org_id AND a.id = f.address_id) AS address, \
     CASE WHEN f.career_none IS NOT NULL THEN \
       (SELECT COALESCE(jsonb_agg(jsonb_build_object('employer_name', c.employer_name, \
          'from', to_char(c.from_month, 'YYYY-MM'), 'to', to_char(c.to_month, 'YYYY-MM'), \
          'position', c.position, 'duty', c.duty, 'leave_reason', c.leave_reason) ORDER BY c.seq), \
          '[]'::jsonb)::text \
        FROM employee_careers c \
        WHERE c.org_id = f.org_id AND c.employee_id = f.employee_id AND c.voided_at IS NULL) END AS careers, \
     (SELECT r.label_ko FROM reason_codes r \
       WHERE r.org_id = e.org_id AND r.domain = 'exit_reason' AND r.code = x.code) AS tenant_label \
     FROM employees e \
     LEFT JOIN employee_register_facts f ON f.org_id = e.org_id AND f.employee_id = e.id \
     CROSS JOIN LATERAL (SELECT ",
    exit_reason_code_sql!(),
    " AS code) x WHERE e.org_id = $1 AND e.id = $2"
);

/// The stored register items; all `None` when nothing was recorded yet.
pub async fn load_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee_id: Uuid,
) -> Result<RegisterRow, HrError> {
    let Some(row) = sqlx::query(LOAD)
        .bind(org)
        .bind(employee_id)
        .fetch_optional(tx.as_mut())
        .await?
    else {
        return Ok(RegisterRow::default());
    };
    let exit_reason_code: Option<String> = row.try_get("exit_reason_code")?;
    let tenant_label: Option<String> = row.try_get("tenant_label")?;
    Ok(RegisterRow {
        sex: row.try_get("sex")?,
        address: row.try_get("address")?,
        careers: row.try_get("careers")?,
        exit_reason_label: exit_reason_code
            .as_deref()
            .and_then(console_hr_domain::register::exit_reason_label)
            .map(str::to_owned)
            .or(tenant_label),
        exit_reason_code,
        register_note: row.try_get("register_note")?,
    })
}

/// The checks a register value cannot pass on its own, run before a value is
/// applied or filed for a second person: a 퇴직 사유 only on an exited
/// record whose exit no live exit case owns (the case's own code is the 사유
/// then), and a tenant code only while active.
pub(crate) async fn check_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee_id: Uuid,
    employment_status: &str,
    exit_reason: Option<&str>,
) -> Result<(), HrError> {
    let Some(code) = exit_reason else {
        return Ok(());
    };
    if employment_status != "EXITED" {
        return Err(refusal(
            StatusCode::CONFLICT,
            "employee_not_exited",
            "an exit reason is recorded only for an exited employee",
        ));
    }
    // A live case owns the 사유 only when its report gave one; a case
    // reported without one leaves the register item to record it.
    let live_case: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM employee_exit_cases WHERE org_id = $1 AND employee_id = $2 \
         AND status NOT IN ('REJECTED', 'CANCELLED') AND exit_reason_code IS NOT NULL)",
    )
    .bind(org)
    .bind(employee_id)
    .fetch_one(tx.as_mut())
    .await?;
    if live_case {
        return Err(refusal(
            StatusCode::CONFLICT,
            "exit_case_owns_exit_reason",
            "this exit was reported through an exit case; its reason is recorded there",
        ));
    }
    if is_tenant_code(code) {
        let active: Option<bool> = sqlx::query_scalar(
            "SELECT active FROM reason_codes WHERE org_id = $1 AND domain = 'exit_reason' AND code = $2",
        )
        .bind(org)
        .bind(code)
        .fetch_optional(tx.as_mut())
        .await?;
        if active != Some(true) {
            return Err(HrError::validation(
                "exit_reason must be an exit_reason catalog code",
            ));
        }
    }
    Ok(())
}

/// Writes normalized `(field, value)` register items for the locked
/// employee. `note` is the correction's note: an exit reason whose code
/// requires one takes it (BW-07).
pub(crate) async fn write_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee_id: Uuid,
    fields: &[(&str, Option<&str>)],
    actor: Uuid,
    note: Option<&str>,
) -> Result<(), HrError> {
    sqlx::query(
        "INSERT INTO employee_register_facts (org_id, employee_id) VALUES ($1, $2) \
         ON CONFLICT (org_id, employee_id) DO NOTHING",
    )
    .bind(org)
    .bind(employee_id)
    .execute(tx.as_mut())
    .await?;
    for (field, value) in fields {
        match *field {
            "address" => write_address(tx, org, employee_id, actor, *value).await?,
            "careers" => write_careers(tx, org, employee_id, actor, *value).await?,
            "exit_reason" | "sex" | "register_note" => {
                if let (true, Some(code)) = (*field == "exit_reason", value) {
                    validate_reason_in_tx(
                        tx.as_mut(),
                        OrgId::from_uuid(org),
                        ReasonDomain::ExitReason,
                        code,
                        note,
                    )
                    .await
                    .map_err(HrError::from_kernel)?;
                }
                set_column(tx, org, employee_id, field, *value).await?;
            }
            other => {
                return Err(HrError::validation(format!(
                    "{other} is not a register item"
                )));
            }
        }
    }
    Ok(())
}

/// Sets one scalar item: `field` is `sex`, `register_note` or `exit_reason`.
async fn set_column(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee_id: Uuid,
    field: &str,
    value: Option<&str>,
) -> Result<(), HrError> {
    sqlx::query(
        "UPDATE employee_register_facts SET \
         sex = CASE WHEN $3 = 'sex' THEN $4 ELSE sex END, \
         register_note = CASE WHEN $3 = 'register_note' THEN $4 ELSE register_note END, \
         exit_reason_code = CASE WHEN $3 = 'exit_reason' THEN $4 ELSE exit_reason_code END, \
         updated_at = now() WHERE org_id = $1 AND employee_id = $2",
    )
    .bind(org)
    .bind(employee_id)
    .bind(field)
    .bind(value)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

async fn write_address(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee_id: Uuid,
    actor: Uuid,
    json: Option<&str>,
) -> Result<(), HrError> {
    // A changed address is a new immutable row; the old one stays.
    let mut address_id: Option<Uuid> = None;
    if let Some(json) = json {
        address_id = Some(
            sqlx::query_scalar(
                "INSERT INTO employee_addresses SELECT * FROM jsonb_populate_record(NULL::employee_addresses, \
                 $1::jsonb || jsonb_build_object('org_id', $2::uuid, 'id', gen_random_uuid(), \
                 'employee_id', $3::uuid, 'created_by', $4::uuid, 'created_at', now())) RETURNING id",
            )
            .bind(json)
            .bind(org)
            .bind(employee_id)
            .bind(actor)
            .fetch_one(tx.as_mut())
            .await?,
        );
    }
    sqlx::query(
        "UPDATE employee_register_facts SET address_id = $3, updated_at = now() \
         WHERE org_id = $1 AND employee_id = $2",
    )
    .bind(org)
    .bind(employee_id)
    .bind(address_id)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

async fn write_careers(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee_id: Uuid,
    actor: Uuid,
    json: Option<&str>,
) -> Result<(), HrError> {
    // The live list is replaced: old rows are voided, never deleted.
    sqlx::query(
        "UPDATE employee_careers SET voided_at = now() \
         WHERE org_id = $1 AND employee_id = $2 AND voided_at IS NULL",
    )
    .bind(org)
    .bind(employee_id)
    .execute(tx.as_mut())
    .await?;
    // One INSERT for the whole list, numbered in list order.
    let mut inserted: Option<u64> = None;
    if let Some(json) = json {
        let done = sqlx::query(
            "INSERT INTO employee_careers (org_id, employee_id, seq, employer_name, from_month, \
             to_month, position, duty, leave_reason, created_by) \
             SELECT $1, $2, r.n, r.v->>'employer_name', to_date(r.v->>'from', 'YYYY-MM'), \
             to_date(r.v->>'to', 'YYYY-MM'), r.v->>'position', r.v->>'duty', r.v->>'leave_reason', $4 \
             FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS r(v, n)",
        )
        .bind(org)
        .bind(employee_id)
        .bind(json)
        .bind(actor)
        .execute(tx.as_mut())
        .await?;
        inserted = Some(done.rows_affected());
    }
    sqlx::query(
        "UPDATE employee_register_facts SET career_none = $3, updated_at = now() \
         WHERE org_id = $1 AND employee_id = $2",
    )
    .bind(org)
    .bind(employee_id)
    .bind(inserted.map(|rows| rows == 0))
    .execute(tx.as_mut())
    .await?;
    Ok(())
}
