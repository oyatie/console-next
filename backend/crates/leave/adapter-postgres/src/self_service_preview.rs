// SPDX-License-Identifier: LicenseRef-Proprietary
use console_kernel_core::{KernelError, UserId};
use console_leave_application::{
    LeaveApprovalPreviewStepView, SelfLeaveApprovalPreviewView, SelfLeaveFilingState,
};
use console_platform_db::with_org_conn;
use console_platform_request_context::current_org;
use sqlx::Row;
use uuid::Uuid;

use super::{require_self_employee, resolve_employee_unit};
use crate::{PgLeaveError, PgLeaveStore};

impl PgLeaveStore {
    pub async fn get_self_approval_preview(
        &self,
        requester: UserId,
    ) -> Result<SelfLeaveApprovalPreviewView, PgLeaveError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn::<_, _, PgLeaveError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let employee_id = require_self_employee(tx, org, requester).await?;
                let (org_unit_id, _, org_unit) =
                    resolve_employee_unit(tx, org, employee_id).await?;
                let branch_row = sqlx::query(
                    r#"
                    SELECT b.id AS branch_id, b.name AS branch_name
                    FROM person_employees_current e
                    JOIN branches b
                      ON b.org_id = e.org_id AND b.id = e.home_branch_id AND b.deactivated_at IS NULL
                    WHERE e.org_id = $1 AND e.id = $2
                    "#,
                )
                .bind(org.as_uuid())
                .bind(employee_id)
                .fetch_optional(tx.as_mut())
                .await?;

                let Some(branch_row) = branch_row else {
                    return Ok(SelfLeaveApprovalPreviewView {
                        filing_state: SelfLeaveFilingState::HomeBranchRequired,
                        home_branch_id: None,
                        branch_name: None,
                        org_unit,
                        steps: Vec::new(),
                    });
                };

                let home_branch_id: Uuid = branch_row.try_get("branch_id")?;
                let branch_name: String = branch_row.try_get("branch_name")?;

                let mut steps = Vec::new();
                if let Some(unit_id) = org_unit_id {
                    let candidates = sqlx::query(
                        r#"
                        SELECT te.name,
                               COALESCE(NULLIF(btrim(jt_pos.label), ''), NULLIF(btrim(te.position), '')) AS position,
                               COALESCE(jt_grade.grade_rank, 0) AS grade_rank
                        FROM person_employees_current te
                        JOIN users u
                          ON u.org_id = te.org_id AND u.employee_id = te.id AND u.is_active
                        JOIN user_branches ub
                          ON ub.org_id = u.org_id AND ub.user_id = u.id AND ub.branch_id = $3
                        LEFT JOIN job_titles jt_pos
                          ON jt_pos.org_id = te.org_id AND jt_pos.id = te.job_title_id
                        LEFT JOIN job_titles jt_grade
                          ON jt_grade.org_id = te.org_id AND jt_grade.id = te.grade_id
                        WHERE te.org_id = $1
                          AND te.org_unit_id = $2
                          AND te.merged_into_employee_id IS NULL
                          AND te.employment_status = 'ACTIVE'
                          AND u.id <> $4
                          AND (
                              'ADMIN' = ANY(u.roles)
                              OR 'SUPER_ADMIN' = ANY(u.roles)
                              OR EXISTS (
                                  SELECT 1 FROM access_grants ag
                                  WHERE ag.org_id = u.org_id
                                    AND ag.account_id = u.id
                                    AND ag.status = 'ACTIVE'
                                    AND ag.valid_from <= now()
                                    AND (ag.valid_to IS NULL OR ag.valid_to > now())
                              )
                          )
                        ORDER BY grade_rank DESC, te.name ASC
                        LIMIT 2
                        "#,
                    )
                    .bind(org.as_uuid())
                    .bind(unit_id)
                    .bind(home_branch_id)
                    .bind(requester.as_uuid())
                    .fetch_all(tx.as_mut())
                    .await?;

                    if candidates.len() == 1 {
                        let c = &candidates[0];
                        steps.push(LeaveApprovalPreviewStepView {
                            order: 1,
                            step_kind: "unit_lead".to_owned(),
                            role_label: "TEAM_LEAD".to_owned(),
                            approver_name: Some(c.try_get("name")?),
                            approver_position: c.try_get("position")?,
                        });
                    }
                }

                let next_order = i32::try_from(steps.len() + 1).unwrap_or(1);
                steps.push(LeaveApprovalPreviewStepView {
                    order: next_order,
                    step_kind: "branch_hr".to_owned(),
                    role_label: format!("{branch_name} Approver"),
                    approver_name: None,
                    approver_position: None,
                });

                Ok(SelfLeaveApprovalPreviewView {
                    filing_state: SelfLeaveFilingState::Ready,
                    home_branch_id: Some(home_branch_id),
                    branch_name: Some(branch_name),
                    org_unit,
                    steps,
                })
            })
        })
        .await
    }
}
