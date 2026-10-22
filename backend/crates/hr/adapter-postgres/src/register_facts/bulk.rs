//! `POST /employees/register-facts/bulk`: the 「근로자 명부 항목」 and
//! 「인적사항」 import profiles and the bulk update of their low-risk items
//! (성별, 주소, 이력 · 경력, 그 밖에 필요한 사항; 한자 · 영문 성명, 국적, 개인
//! 메일, 비상연락처). The browser parses the sheet (no file and
//! no 주민등록번호 reaches the server) and sends one row per employee, keyed by
//! id or 사번. `dry_run` answers what each row would change; the apply is
//! all-or-nothing and writes one ledger row per changed item. A 퇴직 사유 or
//! 그룹 입사일 is taken only as a first recording; changing a recorded one is
//! high-risk and goes through `PATCH /employees/{id}`.

use std::collections::HashSet;

use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext};
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use console_settings_adapter_postgres::validate_reason_in_tx;
use console_settings_domain::code_lists::ReasonDomain;
use http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::authz::authorize_hr_org_wide;
use crate::corrections::{
    FieldValue, LedgerMeta, apply_fields_in_tx, check_against_record, ledger_value, lock_employee,
    normalize_value,
};
use crate::requests::{note, reason_code};
use crate::{HrError, HrService};

/// Most rows one call takes.
pub const MAX_BULK_ROWS: usize = 500;

/// The items a bulk row may carry: the low-risk 명부 items (MR-23) and the
/// 인적사항 extras (MR-34; a 사진 is uploaded per employee, not here).
pub const BULK_FIELDS: [&str; 9] = [
    "sex",
    "address",
    "careers",
    "register_note",
    "name_hanja",
    "name_en",
    "nationality",
    "personal_email",
    "emergency_contacts",
];

/// High-risk items a bulk row takes only as a first recording (an imported
/// 퇴사자's 사유, an imported 그룹입사일); changing a recorded one goes
/// through `PATCH /employees/{id}` and its second person.
pub const FIRST_RECORDING_FIELDS: [&str; 2] = ["exit_reason", "group_service_start_date"];

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BulkRegisterFactsRequest {
    #[serde(default)]
    pub dry_run: bool,
    pub reason_code: String,
    #[serde(default)]
    pub note: Option<String>,
    pub rows: Vec<BulkRegisterRow>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BulkRegisterRow {
    #[serde(default)]
    pub employee_id: Option<Uuid>,
    #[serde(default)]
    pub employee_number: Option<String>,
    pub changes: Map<String, Value>,
}

#[derive(Debug, Serialize)]
pub struct BulkRowOutcome {
    pub index: usize,
    pub employee_id: Option<Uuid>,
    /// Items whose value changes (or would change).
    pub changed: Vec<String>,
    /// Why the row cannot be taken; the apply then writes nothing.
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct BulkRegisterFactsOutcome {
    pub dry_run: bool,
    pub applied: bool,
    pub rows: Vec<BulkRowOutcome>,
}

/// The row's employee, by id or by a 사번 that names exactly one record.
async fn resolve(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    row: &BulkRegisterRow,
) -> Result<Uuid, String> {
    let number = row
        .employee_number
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty());
    let ids: Vec<Uuid> = match (row.employee_id, number) {
        (Some(id), None) => vec![id],
        (None, Some(number)) => sqlx::query_scalar(
            "SELECT id FROM employees WHERE org_id = $1 AND employee_number = $2 LIMIT 2",
        )
        .bind(org)
        .bind(number)
        .fetch_all(tx.as_mut())
        .await
        .map_err(|_| "the employee could not be read".to_owned())?,
        _ => {
            return Err(
                "name the employee with exactly one of employee_id or employee_number".into(),
            );
        }
    };
    match ids.as_slice() {
        [id] => Ok(*id),
        [] => Err("no employee has this employee_number".into()),
        _ => Err("more than one employee has this employee_number".into()),
    }
}

/// The row's `(field, value)` pairs that differ from what is stored, checked
/// against the record as the apply will check them.
async fn plan_row(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee_id: Uuid,
    changes: &Map<String, Value>,
    note: Option<&str>,
) -> Result<Vec<FieldValue>, String> {
    if changes.is_empty() {
        return Err("changes must name at least one item".into());
    }
    let head = lock_employee(tx, org, employee_id)
        .await
        .map_err(|error| error.message)?;
    let mut planned = Vec::new();
    for (field, value) in changes {
        let first =
            FIRST_RECORDING_FIELDS.contains(&field.as_str()) && head.current(field).is_none();
        if !BULK_FIELDS.contains(&field.as_str()) && !first {
            return Err(format!(
                "{field} is not taken in bulk; use {} or a first {}",
                BULK_FIELDS.join(", "),
                FIRST_RECORDING_FIELDS.join(" or ")
            ));
        }
        let stored = normalize_value(field, value).map_err(|error| error.message)?;
        if ledger_value(field, stored.as_deref()) != ledger_value(field, head.current(field)) {
            planned.push((field.clone(), stored));
        }
    }
    check_against_record(tx, org, employee_id, &head, &planned)
        .await
        .map_err(|error| error.message)?;
    // The note rule (BW-07 requires_note), as the apply will check it.
    if let Some((_, Some(code))) = planned.iter().find(|(field, _)| field == "exit_reason") {
        let domain = ReasonDomain::ExitReason;
        validate_reason_in_tx(tx.as_mut(), OrgId::from_uuid(org), domain, code, note)
            .await
            .map_err(|error| error.message)?;
    }
    Ok(planned)
}

impl HrService {
    pub async fn bulk_correct_register_facts(
        &self,
        principal: Principal,
        body: BulkRegisterFactsRequest,
    ) -> Result<BulkRegisterFactsOutcome, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        if body.rows.is_empty() || body.rows.len() > MAX_BULK_ROWS {
            return Err(HrError::validation(format!(
                "rows must hold 1 to {MAX_BULK_ROWS} employees"
            )));
        }
        let reason = reason_code(&body.reason_code, "reason_code")?;
        let note = note(body.note.as_deref())?;
        let me = *principal.user_id.as_uuid();
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        let dry_run = body.dry_run;
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let mut outcomes = Vec::with_capacity(body.rows.len());
                let mut plans = Vec::new();
                let mut seen = HashSet::new();
                for (index, row) in body.rows.iter().enumerate() {
                    let planned = match resolve(tx, org_uuid, row).await {
                        Ok(id) if !seen.insert(id) => {
                            Err((Some(id), "the employee is in more than one row".to_owned()))
                        }
                        Ok(id) => plan_row(tx, org_uuid, id, &row.changes, note.as_deref())
                            .await
                            .map(|planned| (id, planned))
                            .map_err(|error| (Some(id), error)),
                        Err(error) => Err((None, error)),
                    };
                    outcomes.push(match &planned {
                        Ok((id, fields)) => BulkRowOutcome {
                            index,
                            employee_id: Some(*id),
                            changed: fields.iter().map(|(field, _)| field.clone()).collect(),
                            error: None,
                        },
                        Err((id, error)) => BulkRowOutcome {
                            index,
                            employee_id: *id,
                            changed: Vec::new(),
                            error: Some(error.clone()),
                        },
                    });
                    if let Ok(plan) = planned {
                        plans.push(plan);
                    }
                }
                let refused: Vec<Value> = outcomes
                    .iter()
                    .filter(|row| row.error.is_some())
                    .map(|row| json!({ "index": row.index, "employee_id": row.employee_id, "message": row.error }))
                    .collect();
                if dry_run {
                    let outcome = BulkRegisterFactsOutcome { dry_run, applied: false, rows: outcomes };
                    return Ok((outcome, Vec::new()));
                }
                if !refused.is_empty() {
                    return Err(HrError {
                        errors: None,
                        status: StatusCode::UNPROCESSABLE_ENTITY,
                        code: "bulk_register_facts_refused",
                        message: format!(
                            "{} of {} rows cannot be taken; nothing was recorded",
                            refused.len(),
                            outcomes.len()
                        ),
                        refusals: Some(Box::new(Value::Array(refused))),
                    });
                }
                let meta = LedgerMeta {
                    reason_code: &reason,
                    note: note.as_deref(),
                    corrected_by: me,
                    change_request_id: None,
                    review_required: false,
                    // MR-23's profile import is its own all-or-nothing batch,
                    // not an MR-27 bulk 정정 job.
                    batch_id: None,
                };
                let mut changed = 0usize;
                for (employee_id, fields) in plans.iter().filter(|(_, fields)| !fields.is_empty()) {
                    let head = lock_employee(tx, org_uuid, *employee_id).await?;
                    apply_fields_in_tx(tx, org_uuid, *employee_id, &head, fields, &meta).await?;
                    changed += 1;
                }
                // Counts and field names only: the values stay in the ledger rows.
                let event = AuditEvent::new(
                    Some(principal.user_id),
                    AuditAction::new("employee.register_facts.bulk_correct")
                        .map_err(HrError::from_kernel)?,
                    "employee",
                    "bulk",
                    TraceContext::generate(),
                    OffsetDateTime::now_utc(),
                )
                .with_org(org)
                .with_snapshots(
                    None,
                    Some(json!({
                        "rows": outcomes.len(),
                        "employees_changed": changed,
                        "employee_ids": plans.iter().filter(|(_, f)| !f.is_empty()).map(|(id, _)| id).collect::<Vec<_>>(),
                        "reason_code": &reason,
                    })),
                );
                let outcome = BulkRegisterFactsOutcome { dry_run, applied: true, rows: outcomes };
                Ok((outcome, vec![event]))
            })
        })
        .await
    }
}
