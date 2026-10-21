//! The ledger row of a prepared lifecycle event (moved out of `record.rs` to
//! keep it under the size ratchet; MR-24/25 add the classification columns).

use console_hr_domain::lifecycle::classification::classification_columns;
use serde_json::{Value, json};
use sqlx::Postgres;
use uuid::Uuid;

use super::prepare::PreparedLifecycleEvent;
use super::record::promote_from_title;
use crate::HrError;

/// Inserts the event row; `ids` = (org, the new event id, actor, batch).
pub(super) async fn insert_lifecycle_row(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    (org_uuid, lifecycle_id, actor, batch_id): (Uuid, Uuid, Uuid, Option<Uuid>),
    employee_id: Uuid,
    prepared: &PreparedLifecycleEvent,
    scheduled_request: Option<Value>,
) -> Result<(), HrError> {
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
        VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10,
            $11, $12, $13, $14,
            $15, $16, $17,
            $18::DATE, $19::DATE, $20, $21,
            $22, $23,
            $24, $25, $26,
            $27,
            CASE WHEN $4 IN ('CONTRACT_RENEWAL', 'EMPLOYMENT_TYPE_CHANGE') THEN (
                SELECT p.contract_end_date FROM employee_employment_profiles p
                WHERE p.org_id = $2 AND p.employee_id = $3) END,
            $28, $29,
            $30, $31, $32, $33,
            $34, $35, $36, $37,
            $38, $39, $40, $41,
            $42
        )
        "#,
    )
    .bind(lifecycle_id)
    .bind(org_uuid)
    .bind(employee_id)
    .bind(&transition.event_type)
    .bind(&current.employment_status)
    .bind(&transition.to_status)
    .bind(&current.company)
    .bind(&target.company)
    .bind(current.org_unit.as_deref())
    .bind(target.org_unit.as_deref())
    .bind(current.position.as_deref())
    .bind(target.position.as_deref())
    .bind(&transition.effective_date)
    .bind(&transition.comment)
    .bind(json!(&transition.signoffs))
    .bind(actor)
    .bind(transition.to_org_unit_id)
    .bind(transition.expected_return_date.as_deref())
    .bind(transition.contract_end_date.as_deref())
    .bind(transition.leave_type.as_deref())
    .bind(batch_id)
    .bind(if *scheduled { "SCHEDULED" } else { "APPLIED" })
    .bind(scheduled_request)
    .bind(transition.reason_code.as_deref())
    .bind(promote_from_title(current, transition))
    .bind(transition.to_job_title_id)
    .bind(current.org_unit_id)
    .bind(*voids_event_id)
    .bind(target.workplace.map(|to| to.workplace_id))
    .bind(c.from_grade_id)
    .bind(c.to_grade_id)
    .bind(c.from_position_kind_id)
    .bind(c.to_position_kind_id)
    .bind(c.from_job_id)
    .bind(c.to_job_id)
    .bind(c.from_job_family_id)
    .bind(c.to_job_family_id)
    .bind(c.from_job)
    .bind(c.to_job)
    .bind(c.from_employment_type)
    .bind(c.to_employment_type)
    .bind(c.from_contract_start_date)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}
