//! HrService::draft_exit_approval.
//! Handler body moved verbatim from `app/src/hr.rs` (R2-exits).

use console_hr_domain::text::normalize_optional_limited_text;
use console_kernel_core::{AuditAction, AuditEvent, KernelError, TraceContext};
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audit;
use serde_json::json;
use sqlx::Row;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::authz::authorize_hr_case;
use crate::exits::payloads::build_exit_approval_payload;
use crate::exits::queries::load_exit_case_by_id;
use crate::exits::settlement::with_ordinary_wage_basis;
use crate::exits::settlement_store::upsert_exit_settlement_package;
use crate::exits::store::load_exit_case_context;
use crate::exits::types::{DraftEmployeeExitApprovalRequest, EmployeeExitCaseResponse};
use crate::lifecycle::rules::lifecycle_refusal;
use crate::own_record::own_record_guard;
use crate::{HrError, HrService};

impl HrService {
    pub async fn draft_exit_approval(
        &self,
        principal: Principal,
        case_id: Uuid,
        body: DraftEmployeeExitApprovalRequest,
    ) -> Result<EmployeeExitCaseResponse, HrError> {
        let actor = principal.user_id;
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        let note = normalize_optional_limited_text(body.note, 1000, "note")?;

        let event = AuditEvent::new(
            Some(actor),
            AuditAction::new("employee.exit.approval_draft").map_err(HrError::from_kernel)?,
            "employee_exit_case",
            case_id.to_string(),
            TraceContext::generate(),
            OffsetDateTime::now_utc(),
        )
        .with_org(org)
        .with_snapshots(
            None,
            Some(json!({
                "exit_case_id": case_id,
                "submit": body.submit,
                "has_settlement_input": body.settlement_input.is_some(),
                // Certification state is captured in the audit trail: writing the
                // approval_payload (a certification-covered field) atomically resets
                // the package to UNCERTIFIED_DRAFT below, so the settlement figure
                // being drafted/submitted is, by construction, an uncertified draft.
                "certification_status": "UNCERTIFIED_DRAFT"
            })),
        );

        let exit_case = with_audit::<_, _, HrError>(&self.pool, event, |tx| {
        Box::pin(async move {
            let context = load_exit_case_context(tx, org_uuid, case_id, true).await?;
            authorize_hr_case(
                tx, &principal, Feature::ExitSettlementManage, context.branch_id, context.employee_id,
            ).await?;
            own_record_guard(tx, org, actor, context.employee_id, Feature::ExitSettlementManage).await?;
            if !matches!(
                context.status.as_str(),
                "HQ_CONFIRMED" | "SETTLEMENT_READY" | "APPROVAL_DRAFTED"
            ) {
                return Err(HrError::from_kernel(KernelError::invalid_transition(
                    "exit approval draft requires HQ confirmation first",
                )));
            }

            // A filed settlement means the employee has left: submit waits for
            // the exit to take effect (a SCHEDULED exit stays withdrawable by
            // rejecting the case; a failed one is for rejecting).
            if body.submit {
                let exit_state: Option<String> = sqlx::query_scalar(
                    "SELECT l.state FROM employee_exit_cases c \
                     JOIN employee_lifecycle_events l \
                       ON l.id = c.exit_lifecycle_event_id AND l.org_id = c.org_id \
                     WHERE c.org_id = $1 AND c.id = $2",
                )
                .bind(org_uuid)
                .bind(case_id)
                .fetch_optional(tx.as_mut())
                .await?;
                if exit_state.is_some_and(|state| state != "APPLIED") {
                    return Err(lifecycle_refusal(
                        "the exit has not taken effect; submit the settlement once the employee has exited",
                    ));
                }
            }
            let existing_ready_package_id = if body.settlement_input.is_none() {
                sqlx::query_scalar::<_, Uuid>(
                    r#"
                    SELECT id
                    FROM employee_exit_settlement_packages
                    WHERE org_id = $1
                      AND exit_case_id = $2
                      AND severance_pay_won IS NOT NULL
                      AND CARDINALITY(missing_source_fields) = 0
                    ORDER BY updated_at DESC, generated_at DESC
                    LIMIT 1
                    "#,
                )
                .bind(org_uuid)
                .bind(case_id)
                .fetch_optional(tx.as_mut())
                .await?
            } else {
                None
            };
            let package_id = if let Some(package_id) = existing_ready_package_id {
                package_id
            } else {
                upsert_exit_settlement_package(tx, org_uuid, case_id, body.settlement_input.clone())
                    .await?
            };
            let package_ready = sqlx::query(
                r#"
                SELECT severance_pay_won, missing_source_fields,
                       monthly_ordinary_wage_won, ordinary_daily_wage_won,
                       statutory_daily_wage_milliwon
                FROM employee_exit_settlement_packages
                WHERE org_id = $1 AND id = $2
                "#,
            )
            .bind(org_uuid)
            .bind(package_id)
            .fetch_one(tx.as_mut())
            .await?;
            let severance_pay_won: Option<i64> = package_ready.try_get("severance_pay_won")?;
            let missing_source_fields: Vec<String> =
                package_ready.try_get("missing_source_fields")?;
            if severance_pay_won.is_none() || !missing_source_fields.is_empty() {
                return Err(HrError::validation(
                    "exit settlement requires complete wage source fields before approval draft",
                ));
            }

            // Embed the 통상임금 basis into the filed approval document too (0093
            // review HIGH #2), from the same persisted columns the digest covers,
            // so a read-path digest recompute stays consistent.
            let approval_payload = with_ordinary_wage_basis(
                build_exit_approval_payload(&context, note.as_deref()),
                package_ready.try_get("monthly_ordinary_wage_won")?,
                package_ready.try_get("ordinary_daily_wage_won")?,
                package_ready.try_get("statutory_daily_wage_milliwon")?,
            );
            let package_status = if body.submit {
                "SUBMITTED"
            } else {
                "APPROVAL_DRAFTED"
            };
            sqlx::query(
                r#"
                UPDATE employee_exit_settlement_packages
                SET status = $3,
                    approval_payload = $4,
                    submitted_by = CASE WHEN $5 THEN $6 ELSE submitted_by END,
                    submitted_at = CASE WHEN $5 THEN now() ELSE submitted_at END,
                    -- Atomic re-uncertification (0093 HIGH): approval_payload is a
                    -- certification-covered field, so writing it invalidates any
                    -- prior certification in the same statement.
                    certification_status = 'UNCERTIFIED_DRAFT',
                    certification_artifact = NULL,
                    certified_package_digest = NULL,
                    updated_at = now()
                WHERE org_id = $1 AND id = $2
                "#,
            )
            .bind(org_uuid)
            .bind(package_id)
            .bind(package_status)
            .bind(approval_payload)
            .bind(body.submit)
            .bind(*actor.as_uuid())
            .execute(tx.as_mut())
            .await?;

            sqlx::query(
                r#"
                UPDATE employee_exit_cases
                SET status = $3,
                    approval_submitted_by = CASE WHEN $4 THEN $5 ELSE approval_submitted_by END,
                    approval_submitted_at = CASE WHEN $4 THEN now() ELSE approval_submitted_at END,
                    updated_at = now()
                WHERE org_id = $1 AND id = $2
                "#,
            )
            .bind(org_uuid)
            .bind(case_id)
            .bind(if body.submit {
                "SUBMITTED"
            } else {
                "APPROVAL_DRAFTED"
            })
            .bind(body.submit)
            .bind(*actor.as_uuid())
            .execute(tx.as_mut())
            .await?;

            load_exit_case_by_id(tx, org_uuid, case_id).await
        })
    })
    .await?;

        Ok(exit_case)
    }
}
