// SPDX-License-Identifier: LicenseRef-Proprietary
//! One transaction: reverse effects, preserve provenance, append audits and mark the batch.

use console_kernel_core::AuditEvent;
use console_ontology_canonical_adapter_postgres::employee_void::VoidMark;
use console_platform_authz::Principal;
use serde_json::json;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use super::{Loaded, RollbackOutcome, event};
use crate::{
    HrError,
    corrections::{LedgerMeta, apply_fields_in_tx},
};

#[allow(clippy::too_many_arguments)]
pub(super) async fn apply(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    run: Uuid,
    loaded: &Loaded,
    reason: &str,
    note: Option<&str>,
    requested_by: Option<Uuid>,
    review: bool,
) -> Result<(RollbackOutcome, Vec<AuditEvent>), HrError> {
    let org = *principal.org_id.as_uuid();
    let actor = *principal.user_id.as_uuid();
    let p = &loaded.preview;
    let mut audits = Vec::new();
    for row in p.rows.iter().filter(|r| !r.inserted) {
        let fields: Vec<_> = row
            .fields
            .iter()
            .filter(|f| f.field != "home_branch_id")
            .map(|f| (f.field.clone(), f.before.clone()))
            .collect();
        if fields.is_empty() {
            continue;
        }
        let head = loaded
            .heads
            .get(&row.employee_id)
            .ok_or_else(|| HrError::internal("locked import head missing"))?;
        let meta = LedgerMeta {
            import_run_id: Some(run),
            reason_code: "IMPORT_ROLLBACK",
            note,
            corrected_by: actor,
            change_request_id: None,
            review_required: review,
            batch_id: None,
        };
        apply_fields_in_tx(tx, org, row.employee_id, head, &fields, &meta).await?;
    }
    // A setup leave is immutable: append its rescission instead of deleting history.
    sqlx::query("INSERT INTO employee_lifecycle_events (org_id,employee_id,event_type,from_status,to_status,effective_date, \
        comment,reason_code,signoffs,created_by,voids_event_id) \
        SELECT l.org_id,l.employee_id,'RESCIND',l.to_status,COALESCE(l.from_status,'PRE_HIRE'),l.effective_date,NULL,'IMPORT_ROLLBACK','{}'::JSONB,$3,l.id \
        FROM import_run_effects f JOIN employee_lifecycle_events l ON l.org_id=f.org_id AND l.id=f.target_id \
        WHERE f.org_id=$1 AND f.run_id=$2 AND f.effect IN ('setup_leave','onboard_scheduled') AND l.state='APPLIED'")
        .bind(org).bind(run).bind(actor).execute(tx.as_mut()).await?;
    // Drop only actual run additions. Ledger, snapshots, source rows and audits remain append-only.
    console_ontology_canonical_adapter_postgres::employee_void::close_import_employments_in_tx(
        tx, org, run,
    )
    .await?;
    for row in p.rows.iter().filter(|r| r.inserted) {
        let mark = VoidMark {
            voided_by: actor,
            reason_code: reason,
            mode: p.mode,
        };
        crate::registration_void::void_in_tx(
            tx,
            org,
            row.employee_id,
            &mark,
            (p.mode == "SETUP").then_some(false),
        )
        .await?;
        audits.push(crate::registration_void::void_event(principal,"employee.void",row.employee_id,
            json!({"employee_number":row.employee_number,"mode":p.mode,"import_run_id":run,"reason_code":reason}))?);
    }
    let audit = event(
        principal,
        run,
        "data_import.rollback",
        json!({"inserted":p.rows.iter().filter(|r|r.inserted).count(),
        "updated":p.rows.iter().filter(|r|!r.inserted).count(),"mode":p.mode,"requester":requested_by,
        "decider":actor,"reason_code":reason,"digest":p.preview_digest,"review_required":review}),
    )?;
    let trace = console_kernel_core::TraceContext::generate();
    let at = sqlx::query_scalar(
        "SELECT leave_api.mark_employee_import_rolled_back($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    )
    .bind(org)
    .bind(run)
    .bind(actor)
    .bind(requested_by)
    .bind(reason)
    .bind(note)
    .bind(audit.id.as_uuid())
    .bind(trace.trace_id())
    .bind(trace.span_id())
    .fetch_one(tx.as_mut())
    .await?;
    sqlx::query("SELECT leave_api.remove_employee_import_effects($1,$2)")
        .bind(org)
        .bind(run)
        .execute(tx.as_mut())
        .await?;
    audits.push(audit);
    Ok((
        RollbackOutcome {
            run_id: run,
            status: "ROLLED_BACK".into(),
            request_id: None,
            review_required: review,
            rolled_back_at: Some(at),
        },
        audits,
    ))
}

/// Closing a pending request changes the derived run status and must reach open result screens.
pub(crate) fn request_closed_event(
    principal: &Principal,
    request: &crate::requests::ChangeRequestResponse,
) -> Result<AuditEvent, HrError> {
    event(
        principal,
        request.subject_id,
        "data_import.rollback_request_closed",
        json!({"request_id":request.id,"status":request.status,"requester":request.requested_by,
            "actor":principal.user_id,"reason_code":request.decision_reason_code,"digest":request.payload["preview_digest"]}),
    )
}
