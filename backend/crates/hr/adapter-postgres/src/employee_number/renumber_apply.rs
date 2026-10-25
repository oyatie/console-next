//! Applying a previewed renumbering as one job, and its SETUP undo. Both
//! write in two passes (clear, then set) so numbers can move between people
//! of the batch without tripping the tenant-unique 사번 index.

use console_hr_domain::text::parse_yyyy_mm_dd;
use console_kernel_core::tenant_phase::admit_write;
use console_kernel_core::{TenantPhase, WriteClass};
use console_ontology_canonical_adapter_postgres::employee_correction::correct_employee_head_in_tx;
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::Postgres;
use uuid::Uuid;

use super::facts::lock_numbers;
use super::renumber::{RenumberRequest, preview_in_tx};
use super::{audit, check_reason, coded};
use crate::authz::authorize_hr_org_wide;
use crate::clock::today_kst;
use crate::lifecycle::title_reason::coded as kernel_coded;
use crate::{HrError, HrService};

/// The previewed request and the digest the preview answered.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RenumberApplyRequest {
    pub request: RenumberRequest,
    pub preview_digest: String,
}

#[derive(Debug, Serialize)]
pub struct RenumberResult {
    pub batch_id: Uuid,
    pub changed: usize,
}

async fn phase_mode(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    class: WriteClass,
) -> Result<&'static str, HrError> {
    let phase: Option<String> =
        sqlx::query_scalar("SELECT phase FROM tenant_phase WHERE org_id = $1 FOR SHARE")
            .bind(org)
            .fetch_optional(tx.as_mut())
            .await?;
    admit_write(TenantPhase::from_db(phase.as_deref()), class)
        .map(|mode| mode.as_str())
        .map_err(kernel_coded)
}

/// Sets each `(employee, number)` in two passes through the `employees`
/// owner: a unique placeholder first, so numbers can move between people of
/// the batch, then the number.
async fn renumber(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    moves: &[(Uuid, Option<String>)],
) -> Result<(), HrError> {
    for (id, _) in moves {
        crate::employee_state::require_editable(tx.as_mut(), org, *id).await?;
        let placeholder = format!("~{}", id.simple());
        correct_employee_head_in_tx(
            tx,
            org,
            *id,
            &[("employee_number", Some(placeholder.as_str()))],
        )
        .await?;
    }
    for (id, number) in moves {
        correct_employee_head_in_tx(tx, org, *id, &[("employee_number", number.as_deref())])
            .await?;
    }
    Ok(())
}

impl HrService {
    /// # Errors
    /// 409 `renumber_preview_stale` (people or numbers moved since the
    /// preview), `renumber_conflicts`; 422 a reason or date error.
    pub async fn apply_renumber(
        &self,
        principal: Principal,
        body: RenumberApplyRequest,
    ) -> Result<RenumberResult, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let (org, actor) = (principal.org_id, principal.user_id);
        let effective = parse_yyyy_mm_dd(&body.request.effective_date)?;
        if effective > today_kst() {
            return Err(coded(
                StatusCode::UNPROCESSABLE_ENTITY,
                "effective_date_in_future",
                "a renumbering takes effect today or earlier",
            ));
        }
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let org_uuid = *org.as_uuid();
                lock_numbers(tx, org_uuid).await?;
                // SETUP only; a governed renumbering after 운영 시작
                // (step-up, second person) is not built yet. 사번 변경 of one
                // person stays available.
                let mode = phase_mode(tx, org_uuid, WriteClass::SetupVoid).await?;
                check_reason(tx, org, body.request.reason_code.trim(), body.request.note.as_deref()).await?;
                let (preview, kind, scope_id) = preview_in_tx(tx, org_uuid, &body.request).await?;
                if preview.preview_digest != body.preview_digest.trim() {
                    return Err(coded(StatusCode::CONFLICT, "renumber_preview_stale", "people or numbers changed since the preview; preview again"));
                }
                if preview.conflicts > 0 {
                    return Err(coded(StatusCode::CONFLICT, "renumber_conflicts", "some new numbers are held by others"));
                }
                let batch: Uuid = sqlx::query_scalar(
                    "INSERT INTO employee_renumber_batches (org_id, scope_kind, scope_id, prefix, width, \
                       effective_date, reason_code, preview_digest, change_mode, changed, actor_id) \
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id",
                )
                .bind(org_uuid)
                .bind(kind)
                .bind(scope_id)
                .bind(body.request.prefix.trim())
                .bind(i16::from(body.request.width))
                .bind(effective)
                .bind(body.request.reason_code.trim())
                .bind(&preview.preview_digest)
                .bind(mode)
                .bind(i32::try_from(preview.lines.len()).unwrap_or(i32::MAX))
                .bind(*actor.as_uuid())
                .fetch_one(tx.as_mut())
                .await?;
                for line in &preview.lines {
                    sqlx::query(
                        "INSERT INTO employee_number_changes (org_id, employee_id, from_number, to_number, \
                           effective_date, reason_code, note, batch_id, changed_by) \
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
                    )
                    .bind(org_uuid)
                    .bind(line.employee_id)
                    .bind(&line.from)
                    .bind(&line.to)
                    .bind(effective)
                    .bind(body.request.reason_code.trim())
                    .bind(body.request.note.as_deref())
                    .bind(batch)
                    .bind(*actor.as_uuid())
                    .execute(tx.as_mut())
                    .await?;
                }
                let moves: Vec<_> = preview.lines.iter().map(|l| (l.employee_id, Some(l.to.clone()))).collect();
                renumber(tx, org_uuid, &moves).await?;
                let result = RenumberResult { batch_id: batch, changed: moves.len() };
                let event = audit(org, actor, "employee.renumber_apply", "employee_renumber_batch", batch.to_string(),
                    json!({ "scope_kind": kind, "changed": result.changed, "change_mode": mode }))?;
                Ok((result, vec![event]))
            })
        })
        .await
    }

    /// Restores the old numbers of a batch; SETUP only, and only while each
    /// person still holds the number the batch gave them.
    pub async fn undo_renumber(
        &self,
        principal: Principal,
        batch: Uuid,
    ) -> Result<RenumberResult, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let (org, actor) = (principal.org_id, principal.user_id);
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let org_uuid = *org.as_uuid();
                lock_numbers(tx, org_uuid).await?;
                phase_mode(tx, org_uuid, WriteClass::SetupVoid).await?;
                let open: Option<bool> = sqlx::query_scalar(
                    "SELECT undone_at IS NULL FROM employee_renumber_batches WHERE org_id = $1 AND id = $2 FOR UPDATE",
                )
                .bind(org_uuid)
                .bind(batch)
                .fetch_optional(tx.as_mut())
                .await?;
                match open {
                    None => return Err(coded(StatusCode::NOT_FOUND, "not_found", "no such renumbering")),
                    Some(false) => return Err(coded(StatusCode::CONFLICT, "renumber_already_undone", "the renumbering was undone already")),
                    Some(true) => {}
                }
                let lines: Vec<(Uuid, Option<String>, String, Option<String>)> = sqlx::query_as(
                    "SELECT c.employee_id, c.from_number, c.to_number, e.employee_number \
                       FROM employee_number_changes c JOIN employees e ON e.org_id = c.org_id AND e.id = c.employee_id \
                      WHERE c.org_id = $1 AND c.batch_id = $2 AND c.undone_at IS NULL",
                )
                .bind(org_uuid)
                .bind(batch)
                .fetch_all(tx.as_mut())
                .await?;
                if lines.iter().any(|(_, _, to, now)| now.as_deref() != Some(to.as_str())) {
                    return Err(coded(StatusCode::CONFLICT, "renumber_undo_conflict", "a 사번 of the batch changed since; change it back first"));
                }
                let moves: Vec<_> = lines.iter().map(|(id, from, _, _)| (*id, from.clone())).collect();
                renumber(tx, org_uuid, &moves).await?;
                sqlx::query("UPDATE employee_number_changes SET undone_at = now() WHERE org_id = $1 AND batch_id = $2 AND undone_at IS NULL")
                    .bind(org_uuid)
                    .bind(batch)
                    .execute(tx.as_mut())
                    .await?;
                sqlx::query("UPDATE employee_renumber_batches SET undone_at = now(), undone_by = $3 WHERE org_id = $1 AND id = $2")
                    .bind(org_uuid)
                    .bind(batch)
                    .bind(*actor.as_uuid())
                    .execute(tx.as_mut())
                    .await?;
                let result = RenumberResult { batch_id: batch, changed: moves.len() };
                let event = audit(org, actor, "employee.renumber_undo", "employee_renumber_batch", batch.to_string(),
                    json!({ "restored": result.changed }))?;
                Ok((result, vec![event]))
            })
        })
        .await
    }
}
