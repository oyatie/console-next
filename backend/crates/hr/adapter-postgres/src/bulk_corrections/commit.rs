//! Committing a bulk correction: one job, one transaction. The employees are
//! locked in id order and planned again; a plan that no longer matches the
//! preview's digest refuses the whole job (409 `rows_changed_since_preview`,
//! carrying the fresh preview). Then every CHANGE / PENDING row is written
//! through the correction ledger, high-risk fields filed for a second person
//! or applied by the step-up-verified sole holder with the review flag.

use console_hr_domain::corrections::bulk::FieldPath;
use console_hr_domain::requests::ChangeRequestKind;
use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use console_platform_auth::{MobilePasskeyStepUpBinding, MobileStepUpActionKind, PasskeyService};
use console_platform_authz::{Feature, Principal};
use console_platform_db::idempotency::{
    IdempotencyClaim, claim_idempotency_key, complete_idempotency_key, validate_idempotency_key,
};
use console_platform_db::with_audits;
use http::StatusCode;
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use uuid::Uuid;

use super::plan::{PlannedRow, plan, preview};
use super::read::check_request;
use super::select::resolve;
use super::{BulkCorrectionRequest, BulkCorrectionResult, BulkCorrectionResultRow};
use crate::authz::authorize_hr_org_wide;
use crate::corrections::{LedgerMeta, SecondPersonContext, apply_fields_in_tx, refusal};
use crate::idempotency::idempotency_key_reused;
use crate::requests::cedar::sole_holder_cedar;
use crate::requests::create::{NewChangeRequest, insert_change_request_in_tx};
use crate::{HrError, HrService};

const OPERATION: &str = "employee.correction.bulk";

fn audit(
    org: OrgId,
    actor: UserId,
    action: &str,
    kind: &str,
    id: Uuid,
    after: Value,
) -> Result<AuditEvent, HrError> {
    Ok(AuditEvent::new(
        Some(actor),
        AuditAction::new(action).map_err(HrError::from_kernel)?,
        kind,
        id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org)
    .with_snapshots(None, Some(after)))
}

/// The sole holder's step-up over the whole job: bound to the preview id and
/// digest, so it signs exactly the rows the person saw (decisions #7 case B).
fn binding(preview_id: Uuid, digest: &str) -> MobilePasskeyStepUpBinding {
    let kind = MobileStepUpActionKind::ExceptionDecide;
    MobilePasskeyStepUpBinding {
        action_kind: kind,
        object_id: preview_id,
        reason_key: kind.expected_reason_key().to_owned(),
        replay_attempt: None,
        payload_hash: Some(digest.to_owned()),
    }
}

/// Field names of `writes` taking `path` (or any path but SECOND_PERSON).
fn names(row: &PlannedRow, now: bool) -> Vec<String> {
    row.writes
        .iter()
        .filter(|(_, path)| (*path == FieldPath::SecondPerson) != now)
        .map(|((field, _), _)| field.clone())
        .collect()
}

impl HrService {
    /// POST `/api/v1/employees/corrections/bulk` (Idempotency-Key required).
    pub async fn commit_bulk_correction(
        &self,
        principal: Principal,
        passkeys: &PasskeyService,
        idempotency_key: Option<String>,
        body: BulkCorrectionRequest,
        holders: SecondPersonContext,
    ) -> Result<Value, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let key =
            validate_idempotency_key(idempotency_key.as_deref()).map_err(HrError::validation)?;
        let (reason, note) = check_request(&body)?;
        let expected = body
            .preview_digest
            .clone()
            .ok_or_else(|| HrError::validation("preview_digest is required; preview first"))?;
        let fingerprint = body.fingerprint();
        let passkeys = passkeys.clone();
        let (org, actor) = (principal.org_id, principal.user_id);
        let (org_uuid, me) = (*org.as_uuid(), *actor.as_uuid());
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                match claim_idempotency_key(tx, OPERATION, &key, &fingerprint).await? {
                    IdempotencyClaim::Replay(response) => return Ok((response, vec![])),
                    IdempotencyClaim::Mismatch => return Err(idempotency_key_reused()),
                    IdempotencyClaim::Fresh => {}
                }
                let inputs = resolve(tx, &body).await?;
                let ids: Vec<Uuid> = inputs.iter().map(|input| input.employee_id).collect();
                // Id order: the lock order of the bulk lifecycle path and change sets.
                sqlx::query("SELECT id FROM employees WHERE org_id = $1 AND id = ANY($2) ORDER BY id FOR UPDATE")
                    .bind(org_uuid)
                    .bind(&ids)
                    .execute(tx.as_mut())
                    .await?;
                let planned = plan(tx, org_uuid, &inputs, holders).await?;
                let fresh = preview(&planned, &reason, note.as_deref())?;
                if fresh.preview_digest != expected {
                    return Err(HrError {
                        errors: None,
                        status: StatusCode::CONFLICT,
                        code: "rows_changed_since_preview",
                        message: "the employees changed since the preview; nothing was written. Preview again".to_owned(),
                        // Every row as it stands now (outcome, values, code); the
                        // client previews again for a new digest.
                        refusals: Some(Box::new(serde_json::to_value(&fresh.rows).map_err(|_| HrError::internal("preview serialization failed"))?)),
                    });
                }
                if fresh.counts.change + fresh.counts.pending == 0 {
                    return Err(HrError::validation("no selected employee changes; nothing to write"));
                }
                let sole = fresh.step_up_required;
                let mut assertion = None;
                if sole {
                    let envelope = body.step_up.ok_or_else(|| {
                        refusal(StatusCode::UNAUTHORIZED, "step_up_required", "a sole holder's correction of these fields needs a passkey step-up")
                    })?;
                    assertion = Some(
                        passkeys
                            .verify_and_record_step_up_in_tx(tx, envelope, me, &binding(fresh.preview_id, &expected))
                            .await
                            .map_err(|_| refusal(StatusCode::UNAUTHORIZED, "step_up_failed", "the passkey step-up did not verify"))?,
                    );
                }
                let job = fresh.preview_id;
                let mut fields: Vec<String> = planned.iter().flat_map(|p| p.writes.iter().map(|((f, _), _)| f.clone())).collect();
                fields.sort();
                fields.dedup();
                let c = &fresh.counts;
                let inserted = sqlx::query(
                    "INSERT INTO employee_correction_batches (org_id, id, preview_digest, fields, reason_code, \
                        selected_count, change_count, pending_count, unchanged_count, refused_count, review_required, created_by) \
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT DO NOTHING",
                )
                .bind(org_uuid).bind(job).bind(&expected).bind(&fields).bind(&reason)
                .bind(i32::try_from(c.selected).unwrap_or(i32::MAX)).bind(i32::try_from(c.change).unwrap_or(i32::MAX))
                .bind(i32::try_from(c.pending).unwrap_or(i32::MAX)).bind(i32::try_from(c.unchanged).unwrap_or(i32::MAX))
                .bind(i32::try_from(c.refused).unwrap_or(i32::MAX)).bind(sole).bind(me)
                .execute(tx.as_mut())
                .await?
                .rows_affected();
                if inserted == 0 {
                    return Err(refusal(StatusCode::CONFLICT, "bulk_correction_committed", "this preview was already committed; preview again"));
                }
                let mut rows = Vec::with_capacity(planned.len());
                let mut audits = Vec::new();
                for p in &planned {
                    let mut result = BulkCorrectionResultRow {
                        employee_id: p.row.employee_id,
                        outcome: p.row.outcome,
                        applied: names(p, true),
                        pending_request_id: None,
                        code: p.row.code,
                    };
                    let Some(head) = p.head.as_ref().filter(|_| !p.writes.is_empty()) else {
                        rows.push(result);
                        continue;
                    };
                    let review = p.writes.iter().any(|(_, path)| *path == FieldPath::SoleHolderReview);
                    if review {
                        sole_holder_cedar(&principal, p.row.employee_id, holders)?;
                    }
                    let now: Vec<_> = p.writes.iter().filter(|(_, path)| *path != FieldPath::SecondPerson).map(|(pair, _)| pair.clone()).collect();
                    if !now.is_empty() {
                        let meta = LedgerMeta {
                        import_run_id: None, reason_code: &reason, note: note.as_deref(), corrected_by: me, change_request_id: None, review_required: review, batch_id: Some(job) };
                        apply_fields_in_tx(tx, org_uuid, p.row.employee_id, head, &now, &meta).await?;
                    }
                    let later: Map<String, Value> = p.writes.iter().filter(|(_, path)| *path == FieldPath::SecondPerson).map(|((f, v), _)| (f.clone(), json!(v))).collect();
                    if !later.is_empty() {
                        let request = insert_change_request_in_tx(tx, NewChangeRequest {
                            org: org_uuid,
                            kind: ChangeRequestKind::ProfileCorrection,
                            subject_type: "EMPLOYEE",
                            subject_id: p.row.employee_id,
                            // one request per employee; one batch request kind
                            // (design C18, decided once) when second persons need it.
                            payload: &json!({ "changes": later, "bulk_correction_id": job }),
                            reason_code: &reason,
                            note: note.as_deref(),
                            requested_by: me,
                            assignee_user_id: None,
                        }).await?;
                        result.pending_request_id = Some(request.id);
                    }
                    audits.push(audit(org, actor, "employee.correct", "employee", p.row.employee_id, json!({
                        "applied": &result.applied,
                        "pending": names(p, false),
                        "review_required": review,
                        "bulk_correction_id": job,
                        "reason_code": &reason,
                    }))?);
                    rows.push(result);
                }
                // Field names and counts only: the values stay in the ledger rows.
                audits.push(audit(org, actor, "employee.correct.bulk", "employee_correction_batch", job, json!({
                    "fields": &fields,
                    "counts": &fresh.counts,
                    "review_required": sole,
                    "step_up_assertion_id": assertion,
                    "reason_code": &reason,
                }))?);
                let response = serde_json::to_value(BulkCorrectionResult { bulk_correction_id: job, counts: fresh.counts, review_required: sole, rows })
                    .map_err(|_| HrError::internal("response serialization failed"))?;
                complete_idempotency_key(tx, OPERATION, &key, &response).await?;
                Ok((response, audits))
            })
        })
        .await
    }
}
