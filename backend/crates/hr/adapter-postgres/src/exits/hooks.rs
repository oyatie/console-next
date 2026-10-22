// SPDX-License-Identifier: LicenseRef-Proprietary
//! EXIT's apply-time checks run inside LIFE's transaction, including scheduled exits.
use super::guards::{check_exit_guards, record_refusal};
use super::notice::DismissalNotice;
use crate::lifecycle::title_reason::validate_reason_code;
use console_hr_application::lifecycle::hooks::{
    LifecycleApplyEvent, LifecycleApplyHooks, terminate_may_apply,
};
use console_kernel_core::KernelError;
use console_settings_domain::code_lists::ReasonDomain;
use sqlx::{PgConnection, Row};

#[derive(Debug, Clone, Copy)]
pub struct ExitLifecycleHooks;
impl LifecycleApplyHooks<PgConnection> for ExitLifecycleHooks {
    async fn before_apply(
        &self,
        tx: &mut PgConnection,
        event: &LifecycleApplyEvent<'_>,
    ) -> Result<(), KernelError> {
        if event.event_type != "TERMINATE" {
            return Ok(());
        }
        // The fallback is bound to this confirmation transaction, never another open case.
        let row = sqlx::query("SELECT effective_exit_date::text,exit_reason_code,site_manager_note,dismissal_notice_reason,dismissal_notice_served_on::text,dismissal_notice_method,dismissal_notice_evidence_ref FROM employee_exit_cases WHERE org_id=$1 AND employee_id=$2 AND (exit_lifecycle_event_id=$3 OR (status='REPORTED' AND id::text=current_setting('app.confirming_exit_case',true))) ORDER BY (exit_lifecycle_event_id=$3) DESC NULLS LAST LIMIT 1")
            .bind(event.org_id.as_uuid()).bind(event.employee_id).bind(event.event_id).fetch_optional(&mut *tx).await.map_err(|e| KernelError::internal(e.to_string()))?;
        let Some(row) = row else {
            record_refusal(
                event.org_id,
                event.employee_id,
                "apply",
                "exit_case_required",
            );
            return terminate_may_apply(None);
        };
        let code: Option<String> = row.get("exit_reason_code");
        let code = code.ok_or_else(|| {
            record_refusal(
                event.org_id,
                event.employee_id,
                "apply",
                "exit_reason_required",
            );
            KernelError::validation("an exit reason is required for HR confirmation")
                .with_code("exit_reason_required")
        })?;
        let note: String = row.get("site_manager_note");
        let class = validate_reason_code(
            tx,
            event.org_id,
            ReasonDomain::ExitReason,
            &code,
            Some(&note),
        )
        .await
        .map_err(kernel)?;
        let notice = row
            .get::<Option<String>, _>("dismissal_notice_reason")
            .map(|reason_text| DismissalNotice {
                reason_text,
                served_on: row
                    .get::<Option<String>, _>("dismissal_notice_served_on")
                    .unwrap_or_default(),
                method: row
                    .get::<Option<String>, _>("dismissal_notice_method")
                    .unwrap_or_default(),
                evidence_ref: row
                    .get::<Option<String>, _>("dismissal_notice_evidence_ref")
                    .unwrap_or_default(),
            });
        check_exit_guards(
            tx,
            event.org_id,
            event.employee_id,
            &row.get::<String, _>("effective_exit_date"),
            &class,
            notice.as_ref(),
            "apply",
        )
        .await
        .map_err(kernel)
    }
    async fn after_apply(
        &self,
        _: &mut PgConnection,
        _: &LifecycleApplyEvent<'_>,
    ) -> Result<(), KernelError> {
        Ok(())
    }
    async fn on_rescind(
        &self,
        _: &mut PgConnection,
        _: &LifecycleApplyEvent<'_>,
    ) -> Result<(), KernelError> {
        Ok(())
    }
}
fn kernel(error: crate::HrError) -> KernelError {
    let kind = match error.status.as_u16() {
        422 => console_kernel_core::ErrorKind::Validation,
        409 => console_kernel_core::ErrorKind::Conflict,
        _ => console_kernel_core::ErrorKind::Internal,
    };
    KernelError::new(kind, error.message).with_code(error.code)
}
