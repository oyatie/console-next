//! The two reads: the preview (no locks, nothing written) and a recorded job.

use console_kernel_core::KernelError;
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_org_conn;
use sqlx::Row;
use uuid::Uuid;

use super::plan::{plan, preview};
use super::select::{check_shape, resolve};
use super::{
    BulkCorrectionCounts, BulkCorrectionJob, BulkCorrectionPreview, BulkCorrectionRequest,
};
use crate::authz::authorize_hr_org_wide;
use crate::corrections::{SecondPersonContext, normalize_value, route_or_refuse};
use crate::requests::{note, reason_code};
use crate::{HrError, HrService};

/// The request-level checks shared by preview and commit: the shape, the
/// reason, and for a selection the shared values once (a bad value is the
/// request's error, not a refusal repeated on every row).
pub(super) fn check_request(
    body: &BulkCorrectionRequest,
) -> Result<(String, Option<String>), HrError> {
    check_shape(body)?;
    if let Some(changes) = &body.changes {
        for (field, value) in changes {
            route_or_refuse(field)?;
            normalize_value(field, value)?;
        }
    }
    Ok((
        reason_code(&body.reason_code, "reason_code")?,
        note(body.note.as_deref())?,
    ))
}

fn count(row: &sqlx::postgres::PgRow, column: &str) -> Result<usize, HrError> {
    let value: i32 = row.try_get(column)?;
    usize::try_from(value).map_err(|_| HrError::internal("negative count"))
}

impl HrService {
    /// POST `/api/v1/employees/corrections/bulk/preview`.
    pub async fn preview_bulk_correction(
        &self,
        principal: Principal,
        body: BulkCorrectionRequest,
        holders: SecondPersonContext,
    ) -> Result<BulkCorrectionPreview, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let (reason, note) = check_request(&body)?;
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        with_org_conn::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let inputs = resolve(tx, &body).await?;
                let planned = plan(tx, org_uuid, &inputs, holders).await?;
                preview(&planned, &reason, note.as_deref())
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
