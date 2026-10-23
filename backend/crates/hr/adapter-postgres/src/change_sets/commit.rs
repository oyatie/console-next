//! Committing a change set: every line recorded as one lifecycle batch, all or
//! nothing. Stale pins refuse the whole set first (409 `stale_record`, every
//! stale line named); then each line meets the single-event rules exactly as
//! the bulk endpoint applies them (422 `bulk_lifecycle_refused`, every
//! refused line named). The batch rescinds as one (BW-11).

use console_kernel_core::{AuditAction, AuditEvent, TraceContext};
use console_platform_authz::{Feature, Principal};
use console_platform_db::idempotency::{
    IdempotencyClaim, claim_idempotency_key, complete_idempotency_key, validate_idempotency_key,
};
use console_platform_db::with_audits;
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::Row;
use sqlx::postgres::PgRow;
use time::{Date, OffsetDateTime};
use uuid::Uuid;

use super::store::{line_classification, lock_open_set};
use super::{
    ChangeSetCommitResponse, CommitChangeSetRequest, PutChangeSetLineRequest, line_transition,
};
use crate::authz::authorize_hr_org_wide;
use crate::clock::today_kst;
use crate::idempotency::idempotency_key_reused;
use crate::lifecycle::guards::{RecordGuards, check_record_guards};
use crate::lifecycle::prepare::prepare_lifecycle_event;
use crate::lifecycle::record::record_lifecycle_event_tx;
use crate::lifecycle::title_reason::validate_lifecycle_reason;
use crate::{HrError, HrService};

/// A drafted line as the commit reads it, with the employee's version now.
struct LineRow {
    id: Uuid,
    line: PutChangeSetLineRequest,
    head_version: i32,
}

fn line_row(row: &PgRow) -> Result<LineRow, HrError> {
    let on: Date = row.try_get("effective_date")?;
    Ok(LineRow {
        id: row.try_get("id")?,
        head_version: row.try_get("head_version")?,
        line: PutChangeSetLineRequest {
            employee_id: row.try_get("employee_id")?,
            expected_head_version: Some(row.try_get("expected_head_version")?),
            effective_date: on.to_string(),
            to_org_unit_id: row.try_get("to_org_unit_id")?,
            to_job_title_id: row.try_get("to_job_title_id")?,
            to_position: row.try_get("to_position")?,
            reason_code: row.try_get("reason_code")?,
            classify: line_classification(row)?,
            comment: row.try_get("comment")?,
        },
    })
}

fn stale_lines(stale: Vec<Value>) -> HrError {
    HrError {
        errors: None,
        status: StatusCode::CONFLICT,
        code: "stale_record",
        message: format!(
            "{} drafted lines are stale: their employees changed since they were drafted; nothing was recorded",
            stale.len()
        ),
        refusals: Some(Box::new(Value::Array(stale))),
    }
}

impl HrService {
    /// POST `/api/v1/change-sets/{id}/commit` (Idempotency-Key required).
    pub async fn commit_change_set(
        &self,
        principal: Principal,
        set: Uuid,
        idempotency_key: Option<String>,
        body: CommitChangeSetRequest,
    ) -> Result<Value, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let idempotency_key =
            validate_idempotency_key(idempotency_key.as_deref()).map_err(HrError::validation)?;
        let fingerprint = json!({ "change_set_id": set, "body": &body });
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        let actor = principal.user_id;
        let owner = *actor.as_uuid();
        let today = today_kst();

        with_audits::<_, _, HrError>(&self.pool, org, |tx| {
            Box::pin(async move {
                // A commit is one bulk lifecycle batch, so it shares the bulk
                // key namespace (0245's operation CHECK); the fingerprint
                // names the set, so a key reused across the two is a mismatch.
                const OPERATION: &str = "employee.lifecycle.bulk";
                match claim_idempotency_key(tx, OPERATION, &idempotency_key, &fingerprint).await? {
                    IdempotencyClaim::Replay(response) => return Ok((response, vec![])),
                    IdempotencyClaim::Mismatch => return Err(idempotency_key_reused()),
                    IdempotencyClaim::Fresh => {}
                }
                let intent = lock_open_set(tx, org_uuid, owner, set).await?;
                // Employee-id order: the lock order of the bulk path, so a
                // commit and a bulk batch never deadlock.
                let rows = sqlx::query(
                    "SELECT l.id, l.employee_id, l.expected_head_version, l.effective_date, \
                            l.to_org_unit_id, l.to_job_title_id, l.to_position, l.reason_code, \
                            l.comment, e.head_version, l.to_grade_id, l.to_position_kind_id, \
                            l.vacate_position_kind, l.to_job_id, l.to_job, l.to_job_family_id, \
                            l.to_employment_type, l.contract_end_date \
                     FROM change_set_lines l JOIN employees e ON e.org_id = l.org_id AND e.id = l.employee_id \
                     WHERE l.org_id = $1 AND l.change_set_id = $2 \
                     ORDER BY l.employee_id FOR UPDATE OF e",
                )
                .bind(org_uuid)
                .bind(set)
                .fetch_all(tx.as_mut())
                .await?
                .iter()
                .map(line_row)
                .collect::<Result<Vec<_>, HrError>>()?;
                if rows.is_empty() {
                    return Err(HrError::validation("the change set has no lines"));
                }
                let stale: Vec<Value> = rows
                    .iter()
                    .filter(|r| r.line.expected_head_version != Some(r.head_version))
                    .map(|r| json!({ "line_id": r.id, "employee_id": r.line.employee_id,
                                     "expected_head_version": r.line.expected_head_version,
                                     "head_version": r.head_version }))
                    .collect();
                if !stale.is_empty() {
                    return Err(stale_lines(stale));
                }

                let mut prepared_lines = Vec::with_capacity(rows.len());
                let mut refusals = Vec::new();
                for LineRow { id: line_id, line, .. } in rows {
                    let (employee_id, pin) = (line.employee_id, line.expected_head_version);
                    let guards = RecordGuards {
                        expected_head_version: pin,
                        ..RecordGuards::default()
                    };
                    let outcome = async {
                        let transition = line_transition(&intent, &line, body.signoffs.clone())?;
                        validate_lifecycle_reason(tx, org, &transition).await?;
                        let mut prepared =
                            prepare_lifecycle_event(tx, org_uuid, employee_id, transition, today).await?;
                        check_record_guards(tx, org, employee_id, &mut prepared, &guards).await?;
                        Ok::<_, HrError>(prepared)
                    }
                    .await;
                    match outcome {
                        Ok(prepared) => prepared_lines.push((employee_id, prepared)),
                        // A refusal is the line's; a server fault aborts the commit.
                        Err(error) if error.status.is_client_error() => refusals.push(json!({
                            "line_id": line_id,
                            "employee_id": employee_id,
                            "code": error.code,
                            "message": error.message,
                            "refusals": error.refusals,
                        })),
                        Err(error) => return Err(error),
                    }
                }
                if !refusals.is_empty() {
                    let total = refusals.len() + prepared_lines.len();
                    return Err(HrError::bulk_refused(refusals, total));
                }

                let batch_id = Uuid::new_v4();
                let mut items = Vec::with_capacity(prepared_lines.len());
                let mut audits = Vec::with_capacity(prepared_lines.len() + 1);
                for (employee_id, prepared) in &prepared_lines {
                    let (item, event) =
                        record_lifecycle_event_tx(tx, org, actor, *employee_id, prepared, Some(batch_id))
                            .await?;
                    items.push(item);
                    audits.push(event);
                }
                let employee_ids: Vec<Uuid> = prepared_lines.iter().map(|(id, _)| *id).collect();
                audits.push(
                    AuditEvent::new(
                        Some(actor),
                        AuditAction::new("employee.lifecycle.bulk").map_err(HrError::from_kernel)?,
                        "employee_lifecycle_batch",
                        batch_id.to_string(),
                        TraceContext::generate(),
                        OffsetDateTime::now_utc(),
                    )
                    .with_org(org)
                    .with_snapshots(
                        None,
                        Some(json!({
                            "batch_id": batch_id,
                            "change_set_id": set,
                            "event_type": &intent,
                            "employee_ids": &employee_ids,
                            "count": employee_ids.len(),
                        })),
                    ),
                );
                sqlx::query(
                    "UPDATE change_sets SET state = 'COMMITTED', batch_id = $3, closed_at = now() \
                     WHERE org_id = $1 AND id = $2",
                )
                .bind(org_uuid)
                .bind(set)
                .bind(batch_id)
                .execute(tx.as_mut())
                .await?;
                let response = serde_json::to_value(ChangeSetCommitResponse {
                    change_set_id: set,
                    batch_id,
                    items,
                })
                .map_err(|_| HrError::internal("response serialization failed"))?;
                complete_idempotency_key(tx, OPERATION, &idempotency_key, &response).await?;
                Ok((response, audits))
            })
        })
        .await
    }
}
