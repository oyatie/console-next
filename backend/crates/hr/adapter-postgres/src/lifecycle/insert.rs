//! The ledger row of a prepared lifecycle event (moved out of `record.rs` to
//! keep it under the size ratchet; MR-24/25 add the classification columns).

use console_hr_domain::lifecycle::classification::classification_columns;
use serde_json::{Value, json};
use sqlx::Postgres;
use uuid::Uuid;

use super::prepare::PreparedLifecycleEvent;
use super::record::promote_from_title;
use crate::HrError;

/// Inserts prepared event rows in one statement; the bulk input already bounds the batch.
pub(super) async fn insert_lifecycle_rows(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    (org_uuid, actor, batch_id): (Uuid, Uuid, Option<Uuid>),
    rows: &[(Uuid, Uuid, &PreparedLifecycleEvent)],
) -> Result<(), HrError> {
    let values = rows.iter().map(|(lifecycle_id, employee_id, prepared)| {
        let PreparedLifecycleEvent {
            current,
            transition,
            target,
            scheduled,
            voids_event_id,
            ..
        } = prepared;
        // a scheduled PROMOTE/APPOINT keeps the to_ side projected when
        // it was scheduled; the runner rewrites only the from_ side (0266 grant).
        // Grant and rewrite to_ too if a drifted head makes that display wrong.
        let c = classification_columns(current, transition);
        let scheduled_request = scheduled.then(|| serde_json::to_value(transition)).transpose()
            .map_err(|_| HrError::internal("scheduled request serialization failed"))?;
        let mut row = json!({
            "id": lifecycle_id, "org_id": org_uuid, "employee_id": employee_id,
            "event_type": transition.event_type, "from_status": current.employment_status,
            "to_status": transition.to_status, "from_company": current.company, "to_company": target.company,
            "from_org_unit": current.org_unit, "to_org_unit": target.org_unit,
            "from_position": current.position, "to_position": target.position,
            "effective_date": transition.effective_date, "comment": transition.comment,
            "signoffs": transition.signoffs, "created_by": actor, "to_org_unit_id": transition.to_org_unit_id,
            "expected_return_date": transition.expected_return_date, "contract_end_date": transition.contract_end_date,
            "leave_type": transition.leave_type, "batch_id": batch_id,
            "state": if *scheduled { "SCHEDULED" } else { "APPLIED" }, "scheduled_request": scheduled_request,
            "reason_code": transition.reason_code, "from_job_title_id": promote_from_title(current, transition),
            "to_job_title_id": transition.to_job_title_id, "from_org_unit_id": current.org_unit_id,
            "voids_event_id": voids_event_id, "to_workplace_id": target.workplace.map(|to| to.workplace_id),
        });
        row["from_grade_id"] = json!(c.from_grade_id);
        row["to_grade_id"] = json!(c.to_grade_id);
        row["from_position_kind_id"] = json!(c.from_position_kind_id);
        row["to_position_kind_id"] = json!(c.to_position_kind_id);
        row["from_job_id"] = json!(c.from_job_id);
        row["to_job_id"] = json!(c.to_job_id);
        row["from_job_family_id"] = json!(c.from_job_family_id);
        row["to_job_family_id"] = json!(c.to_job_family_id);
        row["from_job"] = json!(c.from_job);
        row["to_job"] = json!(c.to_job);
        row["from_employment_type"] = json!(c.from_employment_type);
        row["to_employment_type"] = json!(c.to_employment_type);
        row["from_contract_start_date"] = json!(c.from_contract_start_date.map(|date| date.to_string()));
        Ok(row)
    }).collect::<Result<Vec<Value>, HrError>>()?;
    sqlx::query(
        r#"
        INSERT INTO employee_lifecycle_events (
            id, org_id, employee_id, event_type, from_status, to_status,
            from_company, to_company, from_org_unit, to_org_unit,
            from_position, to_position, effective_date, comment,
            signoffs, created_by, to_org_unit_id,
            expected_return_date, contract_end_date, leave_type, batch_id,
            state, scheduled_request,
            reason_code, from_job_title_id, to_job_title_id,
            from_org_unit_id, from_contract_end_date, voids_event_id, to_workplace_id,
            from_grade_id, to_grade_id, from_position_kind_id, to_position_kind_id,
            from_job_id, to_job_id, from_job_family_id, to_job_family_id,
            from_job, to_job, from_employment_type, to_employment_type,
            from_contract_start_date
        )
        SELECT r.id, r.org_id, r.employee_id, r.event_type,
            r.from_status, r.to_status, r.from_company, r.to_company,
            r.from_org_unit, r.to_org_unit, r.from_position, r.to_position,
            r.effective_date, r.comment, r.signoffs, r.created_by,
            r.to_org_unit_id, r.expected_return_date, r.contract_end_date, r.leave_type,
            r.batch_id, r.state, r.scheduled_request, r.reason_code,
            r.from_job_title_id, r.to_job_title_id, r.from_org_unit_id, CASE WHEN r.event_type IN ('CONTRACT_RENEWAL', 'EMPLOYMENT_TYPE_CHANGE') THEN p.contract_end_date END,
            r.voids_event_id, r.to_workplace_id, r.from_grade_id, r.to_grade_id,
            r.from_position_kind_id, r.to_position_kind_id, r.from_job_id, r.to_job_id,
            r.from_job_family_id, r.to_job_family_id, r.from_job, r.to_job,
            r.from_employment_type, r.to_employment_type, r.from_contract_start_date
        FROM jsonb_to_recordset($1) AS r(
            id uuid, org_id uuid, employee_id uuid, event_type text, from_status text, to_status text,
            from_company text, to_company text, from_org_unit text, to_org_unit text,
            from_position text, to_position text, effective_date text, comment text,
            signoffs jsonb, created_by uuid, to_org_unit_id uuid,
            expected_return_date date, contract_end_date date, leave_type text, batch_id uuid,
            state text, scheduled_request jsonb, reason_code text, from_job_title_id uuid, to_job_title_id uuid,
            from_org_unit_id uuid, voids_event_id uuid, to_workplace_id uuid,
            from_grade_id uuid, to_grade_id uuid, from_position_kind_id uuid, to_position_kind_id uuid,
            from_job_id uuid, to_job_id uuid, from_job_family_id uuid, to_job_family_id uuid,
            from_job text, to_job text, from_employment_type text, to_employment_type text,
            from_contract_start_date date)
        LEFT JOIN employee_employment_profiles p ON p.org_id=r.org_id AND p.employee_id=r.employee_id
        "#,
    )
    .bind(Value::Array(values))
    .execute(tx.as_mut())
    .await?;
    Ok(())
}
