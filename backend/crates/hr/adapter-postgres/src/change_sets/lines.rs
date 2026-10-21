//! Drafting and removing a change set's lines. A line is checked when it is
//! drafted (shape, employee, unit, title, reason) so errors show in the grid
//! first; the head rules (status, schedule, supersede) run at commit, against
//! the head the commit meets.

use console_hr_domain::lifecycle::signoffs::EmployeeLifecycleSignoffs;
use console_hr_domain::text::parse_yyyy_mm_dd;
use console_kernel_core::KernelError;
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use serde_json::json;
use uuid::Uuid;

use super::store::{draft_audit, load_lines, lock_open_set};
use super::{ChangeSetLine, MAX_CHANGE_SET_LINES, PutChangeSetLineRequest, line_transition};
use crate::authz::authorize_hr_org_wide;
use crate::directory::create::require_assignable_org_unit;
use crate::lifecycle::title_reason::{fill_promote_title, validate_lifecycle_reason};
use crate::{HrError, HrService};

impl HrService {
    /// POST `/api/v1/change-sets/{id}/lines`: drafts the employee's line, or
    /// redrafts it (one line per employee per set). The pin is the client's
    /// `expected_head_version`, else the employee's version now.
    pub async fn put_change_set_line(
        &self,
        principal: Principal,
        set: Uuid,
        body: PutChangeSetLineRequest,
    ) -> Result<ChangeSetLine, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let (org_id, actor) = (principal.org_id, principal.user_id);
        let org = *org_id.as_uuid();
        let owner = *actor.as_uuid();
        with_audits::<_, _, HrError>(&self.pool, org_id, move |tx| {
            Box::pin(async move {
                let intent = lock_open_set(tx, org, owner, set).await?;
                let mut transition =
                    line_transition(&intent, &body, EmployeeLifecycleSignoffs::default())?;
                let head: i32 = sqlx::query_scalar(
                    "SELECT head_version FROM employees WHERE org_id = $1 AND id = $2",
                )
                .bind(org)
                .bind(body.employee_id)
                .fetch_optional(tx.as_mut())
                .await?
                .ok_or_else(|| {
                    HrError::from_kernel(KernelError::not_found("employee not found"))
                })?;
                if let Some(unit) = transition.to_org_unit_id {
                    require_assignable_org_unit(tx, org, unit).await?;
                }
                fill_promote_title(tx, org, &mut transition).await?;
                validate_lifecycle_reason(tx, org_id, &transition).await?;
                let lines: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM change_set_lines \
                     WHERE org_id = $1 AND change_set_id = $2 AND employee_id <> $3",
                )
                .bind(org)
                .bind(set)
                .bind(body.employee_id)
                .fetch_one(tx.as_mut())
                .await?;
                if usize::try_from(lines).unwrap_or(usize::MAX) >= MAX_CHANGE_SET_LINES {
                    return Err(HrError::validation(
                        "a change set holds at most 500 lines; commit this one first",
                    ));
                }
                let classify = &transition.classify;
                let contract_end = transition
                    .contract_end_date
                    .as_deref()
                    .map(parse_yyyy_mm_dd)
                    .transpose()?;
                let line: Uuid = sqlx::query_scalar(
                    "INSERT INTO change_set_lines (org_id, change_set_id, employee_id, \
                        expected_head_version, effective_date, to_org_unit_id, to_job_title_id, \
                        to_position, reason_code, comment, to_grade_id, to_position_kind_id, \
                        vacate_position_kind, to_job_id, to_job, to_job_family_id, \
                        to_employment_type, contract_end_date) \
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) \
                     ON CONFLICT (change_set_id, employee_id) DO UPDATE SET \
                        expected_head_version = EXCLUDED.expected_head_version, \
                        effective_date = EXCLUDED.effective_date, \
                        to_org_unit_id = EXCLUDED.to_org_unit_id, \
                        to_job_title_id = EXCLUDED.to_job_title_id, \
                        to_position = EXCLUDED.to_position, \
                        reason_code = EXCLUDED.reason_code, \
                        comment = EXCLUDED.comment, \
                        to_grade_id = EXCLUDED.to_grade_id, \
                        to_position_kind_id = EXCLUDED.to_position_kind_id, \
                        vacate_position_kind = EXCLUDED.vacate_position_kind, \
                        to_job_id = EXCLUDED.to_job_id, to_job = EXCLUDED.to_job, \
                        to_job_family_id = EXCLUDED.to_job_family_id, \
                        to_employment_type = EXCLUDED.to_employment_type, \
                        contract_end_date = EXCLUDED.contract_end_date, updated_at = now() \
                     RETURNING id",
                )
                .bind(org)
                .bind(set)
                .bind(body.employee_id)
                .bind(body.expected_head_version.unwrap_or(head))
                .bind(parse_yyyy_mm_dd(&transition.effective_date)?)
                .bind(transition.to_org_unit_id)
                .bind(transition.to_job_title_id)
                // By catalog id the label is read at commit, never stored here.
                .bind(
                    transition
                        .to_job_title_id
                        .is_none()
                        .then_some(transition.to_position)
                        .flatten(),
                )
                .bind(&transition.reason_code)
                .bind(&transition.comment)
                .bind(classify.to_grade_id)
                .bind(classify.to_position_kind_id)
                .bind(classify.vacate_position_kind)
                .bind(classify.to_job_id)
                .bind(&classify.to_job)
                .bind(classify.to_job_family_id)
                .bind(&classify.to_employment_type)
                .bind(contract_end)
                .fetch_one(tx.as_mut())
                .await?;
                let drafted = load_lines(tx, org, set, Some(line))
                    .await?
                    .pop()
                    .ok_or_else(|| HrError::internal("drafted line was not read back"))?;
                let after = json!({ "change_set_id": set, "line_id": line, "employee_id": drafted.employee_id });
                let audit = draft_audit(org_id, actor, "employee.change_set.line_put", set, after)?;
                Ok((drafted, vec![audit]))
            })
        })
        .await
    }

    /// DELETE `/api/v1/change-sets/{id}/lines/{line_id}`.
    pub async fn remove_change_set_line(
        &self,
        principal: Principal,
        set: Uuid,
        line: Uuid,
    ) -> Result<(), HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let (principal_org, actor) = (principal.org_id, principal.user_id);
        let org = *principal_org.as_uuid();
        let owner = *actor.as_uuid();
        with_audits::<_, _, HrError>(&self.pool, principal_org, move |tx| {
            Box::pin(async move {
                lock_open_set(tx, org, owner, set).await?;
                let removed = sqlx::query(
                    "DELETE FROM change_set_lines WHERE org_id = $1 AND change_set_id = $2 AND id = $3",
                )
                .bind(org)
                .bind(set)
                .bind(line)
                .execute(tx.as_mut())
                .await?
                .rows_affected();
                if removed == 0 {
                    return Err(HrError::from_kernel(KernelError::not_found(
                        "change set line not found",
                    )));
                }
                let after = json!({ "change_set_id": set, "line_id": line });
                let audit = draft_audit(principal_org, actor, "employee.change_set.line_remove", set, after)?;
                Ok(((), vec![audit]))
            })
        })
        .await
    }
}
