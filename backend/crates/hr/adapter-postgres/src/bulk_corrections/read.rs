//! The two reads: the preview (no locks; only its access record is written)
//! and a recorded job.

use std::collections::BTreeSet;

use console_kernel_core::KernelError;
use console_platform_authz::{Feature, Principal};
use console_platform_db::{with_audits, with_org_conn};
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use super::plan::{CorrectionPlan, plan, preview};
use super::select::{Targets, check_targets, resolve};
use super::{
    BulkCorrectionCounts, BulkCorrectionJob, BulkCorrectionPreview, BulkCorrectionRequest,
};
use crate::authz::authorize_hr_org_wide;
use crate::corrections::SecondPersonContext;
use crate::directory::access_log::{DirectoryAccess, access_event, actor_employee_id};
use crate::requests::{note, reason_code};
use crate::{HrError, HrService};

pub(super) struct CheckedRequest {
    pub preview_digest: Option<String>,
    pub step_up: Option<console_platform_auth::MobilePasskeyStepUpEnvelope>,
    pub targets: Targets,
    pub reason: String,
    pub note: Option<String>,
}

/// The request-level checks shared by preview and commit: the shape, the
/// reason, and for a selection the shared values once (a bad value is the
/// request's error, not a refusal repeated on every row).
pub(super) fn check_request(body: BulkCorrectionRequest) -> Result<CheckedRequest, HrError> {
    Ok(CheckedRequest {
        preview_digest: body.preview_digest,
        step_up: body.step_up,
        targets: check_targets(body.selection, body.changes, body.rows)?,
        reason: reason_code(&body.reason_code, "reason_code")?,
        note: note(body.note.as_deref())?,
    })
}

fn count(row: &sqlx::postgres::PgRow, column: &str) -> Result<usize, HrError> {
    let value: i32 = row.try_get(column)?;
    usize::try_from(value).map_err(|_| HrError::internal("negative count"))
}

impl HrService {
    /// POST `/api/v1/employees/corrections/bulk/preview`. The rows show each
    /// selected person's stored values, so the preview is a list read: one
    /// access record names the people whose record was read and the fields.
    pub async fn preview_bulk_correction(
        &self,
        principal: Principal,
        body: BulkCorrectionRequest,
        holders: SecondPersonContext,
    ) -> Result<BulkCorrectionPreview, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let CheckedRequest {
            mut targets,
            reason,
            note,
            ..
        } = check_request(body)?;
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let inputs = resolve(tx, &mut targets).await?;
                let planned = plan(tx, org_uuid, inputs, holders).await?;
                let CorrectionPlan { preview, records } =
                    preview(planned, &reason, note.as_deref())?;
                let shown: Vec<Uuid> = preview
                    .rows
                    .iter()
                    .zip(records)
                    .filter(|(_, record)| record.head.is_some())
                    .map(|(row, _)| row.employee_id)
                    .collect();
                let fields: BTreeSet<&str> = preview
                    .rows
                    .iter()
                    .flat_map(|r| r.fields.iter().map(|f| f.field.as_str()))
                    .collect();
                let me = actor_employee_id(tx, &principal).await?;
                let event = access_event(
                    &principal,
                    DirectoryAccess::List,
                    &shown,
                    me,
                    json!({
                        "view": "bulk_correction_preview",
                        "fields": fields,
                        "row_count": preview.rows.len(),
                    }),
                )?;
                Ok((preview, vec![event]))
            })
        })
        .await
    }

    /// GET `/api/v1/employees/corrections/bulk/{id}`: a committed job.
    pub async fn bulk_correction_job(
        &self,
        principal: Principal,
        id: Uuid,
    ) -> Result<BulkCorrectionJob, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        with_org_conn::<_, _, HrError>(&self.pool, principal.org_id, move |tx| {
            Box::pin(async move {
                let row = sqlx::query(
                    "SELECT id, fields, reason_code, selected_count, change_count, pending_count, \
                            unchanged_count, refused_count, review_required, created_by, created_at \
                     FROM employee_correction_batches WHERE id = $1",
                )
                .bind(id)
                .fetch_optional(tx.as_mut())
                .await?
                .ok_or_else(|| {
                    HrError::from_kernel(KernelError::not_found("bulk correction not found"))
                })?;
                Ok(BulkCorrectionJob {
                    id: row.try_get("id")?,
                    fields: row.try_get("fields")?,
                    reason_code: row.try_get("reason_code")?,
                    counts: BulkCorrectionCounts {
                        selected: count(&row, "selected_count")?,
                        change: count(&row, "change_count")?,
                        pending: count(&row, "pending_count")?,
                        unchanged: count(&row, "unchanged_count")?,
                        refused: count(&row, "refused_count")?,
                    },
                    review_required: row.try_get("review_required")?,
                    created_by: row.try_get("created_by")?,
                    created_at: row.try_get("created_at")?,
                })
            })
        })
        .await
    }
}
