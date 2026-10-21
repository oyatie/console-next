//! PATCH the EMP-MODEL facts (concurrent-editing ME-6): JSON Patch with a
//! `test` per touched path, checked by the shared evaluator under the row
//! lock. It records facts that hold no value yet; every write goes through
//! the one correction path (`corrections::apply_fields_in_tx`: the same
//! checks, writers and 정정 ledger), and a value already recorded is changed
//! only by a correction (`PATCH /employees/{id}`, 409 `correction_required`).

use console_kernel_core::{AuditAction, AuditEvent, KernelError, TraceContext};
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use console_platform_preconditions::{ActorClearance, PatchOp, Provenance, Refusal, check_patch};
use http::StatusCode;
use serde_json::{Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

use super::read::{EmploymentFacts, load_facts};
use crate::authz::{authorize_hr_person, hr_reach};
use crate::corrections::{
    FieldValue, LedgerMeta, apply_fields_in_tx, lock_employee, normalize_value,
};
use crate::{HrError, HrService};

/// The only paths a PATCH may write. Everything else on the record is read
/// only (hire date, type, derived classification, probation clock).
const WRITABLE: [&str; 6] = [
    "/birth_date",
    "/work_email",
    "/id_type",
    "/employment/base_pay_won",
    "/employment/pay_unit",
    "/employment/probation_end_date",
];

/// 409 `correction_required`: a recorded value is changed only through the
/// governed 정정 (BW-18), never by a field edit.
const CORRECTION_REQUIRED: &str = "correction_required";

/// The ledger reason of a first recording through this PATCH (no 정정 reason
/// applies: nothing was recorded before).
const FIRST_RECORD: &str = "FIRST_RECORD";

pub(crate) fn refusal_error(refusal: &Refusal) -> HrError {
    HrError {
        status: StatusCode::from_u16(refusal.status).unwrap_or(StatusCode::CONFLICT),
        code: refusal.code,
        message: format!(
            "{} refused on {} field(s)",
            refusal.code,
            refusal.errors.len()
        ),
        refusals: serde_json::to_value(&refusal.errors).ok(),
    }
}

/// Who changed the record is not stored, so the actor stays hidden; `at` is
/// the head's `updated_at` (ME-8).
pub(crate) fn provenance(facts: &EmploymentFacts) -> Provenance {
    let at = facts.updated_at.format(&Rfc3339).unwrap_or_default();
    Provenance::new("", at, ActorClearance::Covert)
}

/// Applies the write ops to `doc`. Only object members on the writable paths;
/// `remove` clears a field to null.
fn apply(doc: &mut Value, ops: &[PatchOp]) -> Result<(), HrError> {
    for op in ops {
        let (path, value) = match op {
            PatchOp::Test { .. } => continue,
            PatchOp::Add { path, value } | PatchOp::Replace { path, value } => {
                (path, value.clone())
            }
            PatchOp::Remove { path } => (path, Value::Null),
            PatchOp::Move { .. } | PatchOp::Copy { .. } => {
                return Err(HrError::validation(
                    "only test, add, replace and remove are supported",
                ));
            }
        };
        if !WRITABLE.contains(&path.as_str()) {
            return Err(HrError::validation(format!("{path} is read only")));
        }
        let slot = doc.pointer_mut(path).ok_or_else(no_profile)?;
        *slot = value;
    }
    Ok(())
}

/// A roster-import row has no profile: say so, instead of letting a `test`
/// on `/employment/…` read as a field conflict.
fn no_profile() -> HrError {
    HrError::from_kernel(KernelError::conflict(
        "the employee has no employment profile; register the employment first",
    ))
}

fn touches_employment(op: &PatchOp) -> bool {
    let path = match op {
        PatchOp::Test { path, .. }
        | PatchOp::Add { path, .. }
        | PatchOp::Replace { path, .. }
        | PatchOp::Remove { path }
        | PatchOp::Move { path, .. }
        | PatchOp::Copy { path, .. } => path,
    };
    path.starts_with("/employment")
}

/// The facts that differ between `current` and `next` as correction fields
/// with their new JSON value, and whether each was already recorded. The pay
/// is one pair, recorded once its unit is.
fn changed(current: &EmploymentFacts, next: &EmploymentFacts) -> Vec<(&'static str, Value, bool)> {
    let mut out = Vec::new();
    if next.birth_date != current.birth_date {
        out.push((
            "birth_date",
            json!(next.birth_date),
            current.birth_date.is_some(),
        ));
    }
    if next.work_email != current.work_email {
        out.push((
            "work_email",
            json!(next.work_email),
            current.work_email.is_some(),
        ));
    }
    if next.id_type != current.id_type {
        out.push(("id_type", json!(next.id_type), current.id_type.is_some()));
    }
    if let (Some(before), Some(after)) = (&current.employment, &next.employment) {
        let recorded = before.pay_unit.is_some();
        if (before.base_pay_won, before.pay_unit) != (after.base_pay_won, after.pay_unit) {
            out.push(("base_pay", json!(after.base_pay_won), recorded));
            out.push(("pay_unit", json!(after.pay_unit), recorded));
        }
        if after.probation_end_date != before.probation_end_date {
            let recorded = before.probation_end_date.is_some();
            out.push((
                "probation_end_date",
                json!(after.probation_end_date),
                recorded,
            ));
        }
    }
    out
}

impl HrService {
    pub async fn patch_employment_facts(
        &self,
        principal: Principal,
        employee_id: Uuid,
        ops: Vec<PatchOp>,
    ) -> Result<EmploymentFacts, HrError> {
        hr_reach(&principal, Feature::EmployeeDirectoryManage)?;
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        let actor = principal.user_id;
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                authorize_hr_person(tx, &principal, Feature::EmployeeDirectoryManage, employee_id).await?;
                let current = load_facts(tx, org_uuid, employee_id, true).await?;
                crate::own_record::own_record_guard(tx, org, actor, employee_id, Feature::EmployeeDirectoryManage).await?;
                if current.employment.is_none() && ops.iter().any(touches_employment) {
                    return Err(no_profile());
                }
                let current_doc = serde_json::to_value(&current).map_err(|e| HrError::internal(e.to_string()))?;
                // The route is manager-only and the record is the manager's
                // own read: every path passes the read check (ME-11).
                check_patch(&ops, &current_doc, &provenance(&current), |_| true)
                    .map_err(|refusal| refusal_error(&refusal))?;
                let mut doc = current_doc;
                apply(&mut doc, &ops)?;
                let next: EmploymentFacts = serde_json::from_value(doc)
                    .map_err(|e| HrError::validation(e.to_string()))?;
                if let Some(after) = &next.employment
                    && after.base_pay_won.is_some() != after.pay_unit.is_some()
                {
                    return Err(HrError::validation("base_pay_won and pay_unit are recorded together"));
                }
                let changes = changed(&current, &next);
                let mut fields: Vec<FieldValue> = Vec::with_capacity(changes.len());
                for (field, value, _) in &changes {
                    fields.push(((*field).to_owned(), normalize_value(field, value)?));
                }
                let recorded: Vec<&str> =
                    changes.iter().filter(|(_, _, recorded)| *recorded).map(|(field, _, _)| *field).collect();
                if !recorded.is_empty() {
                    return Err(HrError {
                        status: StatusCode::CONFLICT,
                        code: CORRECTION_REQUIRED,
                        message: format!(
                            "{} already recorded; change it with a correction (PATCH /employees/{{id}})",
                            recorded.join(", ")
                        ),
                        refusals: None,
                    });
                }
                if fields.is_empty() {
                    return Ok((current, Vec::new()));
                }
                let head = lock_employee(tx, org_uuid, employee_id).await?;
                let meta = LedgerMeta {
                    reason_code: FIRST_RECORD,
                    note: None,
                    corrected_by: *actor.as_uuid(),
                    change_request_id: None,
                    review_required: false,
                    batch_id: None,
                };
                apply_fields_in_tx(tx, org_uuid, employee_id, &head, &fields, &meta).await?;
                let after = load_facts(tx, org_uuid, employee_id, false).await?;
                let changed: Vec<&str> = changes.iter().map(|(field, _, _)| *field).collect();
                // Field names only: the values are personal data (PII minimisation).
                let audit = AuditEvent::new(
                    Some(actor),
                    AuditAction::new("employee.facts.update").map_err(HrError::from_kernel)?,
                    "employee",
                    employee_id.to_string(),
                    TraceContext::generate(),
                    OffsetDateTime::now_utc(),
                )
                .with_org(org)
                .with_snapshots(None, Some(json!({ "changed": changed })));
                Ok((after, vec![audit]))
            })
        })
        .await
    }
}
