// SPDX-License-Identifier: LicenseRef-Proprietary
use axum::extract::{Path, State};
use axum::{Extension, Json};
use console_hr_adapter_postgres::HrError;
use console_hr_adapter_postgres::import::store::import_run_for_update;
use console_hr_adapter_postgres::import::types::ImportApplyRequest;
use console_hr_rest::HrApiError;
use console_kernel_core::{AuditAction, AuditEvent, TraceContext};
use console_platform_authz::Principal;
use console_platform_db::with_audit;
use serde_json::json;
use time::OffsetDateTime;
use uuid::Uuid;

use super::{
    AttendanceImportApplyReport, HrState, attendance_access, attendance_import_batch,
    ensure_attendance_import_run, evaluate_ingest_checklist_gate, load_attendance_import_rows,
    resolve_attendance_import_rows,
};

pub(super) async fn apply_attendance_import(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Path(run_id): Path<Uuid>,
    body: Option<Json<ImportApplyRequest>>,
) -> Result<Json<AttendanceImportApplyReport>, HrApiError> {
    let checklist_all_acknowledged = body.and_then(|Json(b)| b.checklist_all_acknowledged);
    let gate_outcome = evaluate_ingest_checklist_gate(checklist_all_acknowledged)?;
    let org = principal.org_id;
    let org_uuid = *org.as_uuid();
    let actor = principal.user_id;

    let event = AuditEvent::new(
        Some(actor),
        AuditAction::new("attendance_import.apply").map_err(HrError::from_kernel)?,
        "data_import_run",
        run_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org)
    .with_snapshots(
        None,
        Some(json!({
            "run_id": run_id,
            "entity_type": "attendance_direct",
            "gate_outcome": gate_outcome
        })),
    );

    let report = with_audit::<_, _, HrError>(&state.pool, event, |tx| {
        Box::pin(async move {
            attendance_access::require(tx, org, actor, None).await?;
            let run = import_run_for_update(tx, org_uuid, run_id).await?;
            ensure_attendance_import_run(&run, &["DRY_RUN"])?;
            let rows = load_attendance_import_rows(tx, org_uuid, run_id).await?;
            let summary = resolve_attendance_import_rows(tx, org_uuid, run_id, &run, &rows).await?;
            if summary.ready_rows_for_apply.is_empty() {
                return Err(HrError::validation(
                    "cannot apply attendance import with unresolved or invalid rows",
                ));
            }

            let inserted = attendance_import_batch::insert_attendance_direct_import_events(
                tx,
                org_uuid,
                run_id,
                &run.source_sha256,
                &summary.ready_rows_for_apply,
            )
            .await?;

            let report = AttendanceImportApplyReport {
                run_id,
                inserted,
                skipped: summary.ready_rows.saturating_sub(inserted),
                error_rows: summary.error_rows,
                skipped_rows: summary.row_errors,
            };
            sqlx::query(
                r#"
                    UPDATE data_import_runs
                    SET status = 'APPLIED', apply_summary = $3, applied_by = $4,
                        applied_at = now(), updated_at = now()
                    WHERE org_id = $1 AND id = $2
                    "#,
            )
            .bind(org_uuid)
            .bind(run_id)
            .bind(json!(&report))
            .bind(*actor.as_uuid())
            .execute(tx.as_mut())
            .await?;
            Ok(report)
        })
    })
    .await?;

    metrics::counter!("hr_attendance_import_runs_total", "stage" => "apply").increment(1);
    Ok(Json(report))
}
