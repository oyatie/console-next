//! HrService::report_exit_case.
//! Handler body moved verbatim from `app/src/hr.rs` (R2-exits).

use crate::lifecycle::title_reason::coded;
use console_hr_domain::text::{normalize_date_text, normalize_limited_text, parse_yyyy_mm_dd};
use console_kernel_core::{AuditAction, AuditEvent, BranchId, KernelError, TraceContext};
use console_platform_authz::{Feature, Principal};
use console_platform_db::idempotency::{
    IdempotencyClaim, claim_idempotency_key, complete_idempotency_key,
};
use console_platform_db::with_audits;
use http::StatusCode;
use serde_json::{Value, json};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::authz::authorize_hr_case;
use crate::exits::queries::load_exit_case_by_id;
use crate::exits::reason::checked_exit_reason;
use crate::exits::store::resolve_exit_case_branch;
use crate::exits::types::ReportEmployeeExitCaseRequest;
use crate::idempotency::idempotency_key_reused;
use crate::lifecycle::rules::lifecycle_refusal;
use crate::own_record::own_record_guard;
use crate::{HrError, HrService};

impl HrService {
    pub async fn report_exit_case(
        &self,
        principal: Principal,
        idempotency_key: String,
        body: ReportEmployeeExitCaseRequest,
    ) -> Result<(StatusCode, Value), HrError> {
        let fingerprint = json!(&body);
        let effective_exit_date = normalize_date_text(&body.effective_exit_date)?;
        let site_manager_note =
            normalize_limited_text(body.site_manager_note, 1000, "site_manager_note")?;
        let actor = principal.user_id;
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();

        let exit_case = with_audits::<_, _, HrError>(&self.pool, org, |tx| {
            Box::pin(async move {
                let branch_id = resolve_exit_case_branch(
                    tx,
                    org_uuid,
                    body.employee_id,
                    body.branch_id,
                    body.absence_alert_id,
                )
                .await?;
                authorize_hr_case(
                    tx,
                    &principal,
                    Feature::ExitCaseReport,
                    branch_id,
                    body.employee_id,
                )
                .await?;
                own_record_guard(tx, org, actor, body.employee_id, Feature::ExitCaseReport).await?;
                const OPERATION: &str = "hr.exit_case.create";
                match claim_idempotency_key(tx, OPERATION, &idempotency_key, &fingerprint).await? {
                    IdempotencyClaim::Replay(response) => {
                        return Ok(((StatusCode::OK, response), vec![]));
                    }
                    IdempotencyClaim::Mismatch => return Err(idempotency_key_reused()),
                    IdempotencyClaim::Fresh => {}
                }
                // After the claim: a replay answers what was recorded.
                let exit_reason = checked_exit_reason(
                    tx,
                    org,
                    body.exit_reason_code.as_deref(),
                    &site_manager_note,
                )
                .await?;
                if let Some(class) = &exit_reason {
                    super::guards::check_exit_guards(
                        tx.as_mut(),
                        org,
                        body.employee_id,
                        &effective_exit_date,
                        class,
                        None,
                        "report",
                    )
                    .await?;
                }
                let exit_reason_code = exit_reason.as_ref().map(|r| &r.code);
                let exited: bool = sqlx::query_scalar(
                "SELECT employment_status = 'EXITED' FROM employees WHERE org_id = $1 AND id = $2",
            )
            .bind(org_uuid)
            .bind(body.employee_id)
            .fetch_one(tx.as_mut())
            .await?;
                if exited {
                    return Err(lifecycle_refusal(
                        "employee is already EXITED; no exit case can be reported",
                    ));
                }
                let hire: Option<String> = sqlx::query_scalar(
                    "SELECT hire_date FROM employees WHERE org_id = $1 AND id = $2",
                )
                .bind(org_uuid)
                .bind(body.employee_id)
                .fetch_one(tx.as_mut())
                .await?;
                if let (Some(hire), Ok(exit)) = (
                    hire.as_deref()
                        .and_then(|d| parse_yyyy_mm_dd(d.trim()).ok()),
                    parse_yyyy_mm_dd(&effective_exit_date),
                ) && exit < hire
                {
                    return Err(coded(
                        KernelError::validation(format!(
                            "effective_exit_date must be on or after the hire date {hire}"
                        ))
                        .with_code("effective_date_before_hire")
                        .with_field("effective_exit_date"),
                    ));
                }
                let exit_scheduled: bool = sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM employee_lifecycle_events \
                 WHERE org_id = $1 AND employee_id = $2 AND event_type = 'TERMINATE' \
                   AND state = 'SCHEDULED')",
                )
                .bind(org_uuid)
                .bind(body.employee_id)
                .fetch_one(tx.as_mut())
                .await?;
                if exit_scheduled {
                    return Err(lifecycle_refusal(
                        "employee already has a scheduled exit; no exit case can be reported",
                    ));
                }

                let case_id: Option<Uuid> = sqlx::query_scalar(
                    r#"
                INSERT INTO employee_exit_cases (
                    org_id, employee_id, branch_id, absence_alert_id,
                    effective_exit_date, site_manager_note, reported_by, exit_reason_code
                )
                VALUES ($1, $2, $3, $4, $5::DATE, $6, $7, $8)
                ON CONFLICT (org_id, employee_id)
                    WHERE status NOT IN ('REJECTED','CANCELLED','SUBMITTED')
                DO NOTHING
                RETURNING id
                "#,
                )
                .bind(org_uuid)
                .bind(body.employee_id)
                .bind(branch_id)
                .bind(body.absence_alert_id)
                .bind(&effective_exit_date)
                .bind(&site_manager_note)
                .bind(*actor.as_uuid())
                .bind(exit_reason_code)
                .fetch_optional(tx.as_mut())
                .await?;
                // PEOPLE-B: an open case already exists (the partial unique
                // index) → 409 naming it, instead of the 23505 → 500.
                let Some(case_id) = case_id else {
                    return Err(exit_case_open(tx, org_uuid, body.employee_id).await?);
                };

                if let Some(alert_id) = body.absence_alert_id {
                    let updated = sqlx::query(
                        r#"
                    UPDATE employee_absence_alerts
                    SET status = 'LINKED_EXIT',
                        linked_exit_case_id = $3,
                        updated_at = now()
                    WHERE org_id = $1 AND id = $2
                    "#,
                    )
                    .bind(org_uuid)
                    .bind(alert_id)
                    .bind(case_id)
                    .execute(tx.as_mut())
                    .await?;
                    if updated.rows_affected() != 1 {
                        return Err(HrError::from_kernel(KernelError::internal(
                            "locked absence alert disappeared before exit-case linkage",
                        )));
                    }
                }

                let exit_case = load_exit_case_by_id(tx, org_uuid, case_id).await?;
                let mut event = AuditEvent::new(
                    Some(actor),
                    AuditAction::new("employee.exit.report").map_err(HrError::from_kernel)?,
                    "employee",
                    body.employee_id.to_string(),
                    TraceContext::generate(),
                    OffsetDateTime::now_utc(),
                )
                .with_org(org)
                .with_snapshots(
                    None,
                    Some(json!({
                        "employee_id": body.employee_id,
                        "absence_alert_id": body.absence_alert_id,
                        "effective_exit_date": effective_exit_date,
                        "exit_reason_code": exit_reason_code,
                        "branch_id": branch_id,
                        "requested_branch_id": body.branch_id
                    })),
                );
                if let Some(branch_id) = branch_id {
                    event = event.with_branch(BranchId::from_uuid(branch_id));
                }
                let response = serde_json::to_value(&exit_case)
                    .map_err(|_| HrError::internal("response serialization failed"))?;
                complete_idempotency_key(tx, OPERATION, &idempotency_key, &response).await?;
                Ok(((StatusCode::CREATED, response), vec![event]))
            })
        })
        .await?;

        Ok(exit_case)
    }
}

/// 409 `exit_case_open`: the employee's open case, in `refusals[0]` as
/// `{ case_id, reported_by, reported_at }`.
pub(crate) async fn exit_case_open(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org_id: Uuid,
    employee_id: Uuid,
) -> Result<HrError, HrError> {
    let (case_id, reported_by, reported_at): (Uuid, Uuid, OffsetDateTime) = sqlx::query_as(
        "SELECT id, reported_by, reported_at FROM employee_exit_cases \
         WHERE org_id = $1 AND employee_id = $2 \
           AND status NOT IN ('REJECTED','CANCELLED','SUBMITTED')",
    )
    .bind(org_id)
    .bind(employee_id)
    .fetch_one(tx.as_mut())
    .await?;
    Ok(HrError {
        errors: None,
        status: StatusCode::CONFLICT,
        code: "exit_case_open",
        message: "the employee already has an open exit case".to_owned(),
        refusals: Some(Box::new(json!([{
            "case_id": case_id,
            "reported_by": reported_by,
            "reported_at": reported_at.format(&time::format_description::well_known::Rfc3339)
                .map_err(|_| HrError::internal("exit case timestamp is not representable"))?,
        }]))),
    })
}
