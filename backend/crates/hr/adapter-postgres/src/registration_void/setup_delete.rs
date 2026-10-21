//! `DELETE /employees/{id}` during SETUP: the record goes at once. It is
//! voided, tombstoned in the same transaction and its 사번 freed; the row
//! stays only as the hidden tombstone, because the registration already wrote
//! append-only history (the ONBOARD 발령, the person's revisions) that a hard
//! delete could not remove. An EXITED person still inside the 근로자 명부
//! period needs the actor's confirmation that the original register is kept.

use console_hr_domain::registration_void::check_setup_delete;
use console_kernel_core::WriteClass;
use console_ontology_canonical_adapter_postgres::employee_void::VoidMark;
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use console_settings_domain::SettingKey;
use serde_json::json;
use uuid::Uuid;

use super::apply::{void_event, void_in_tx};
use super::facts::{admit, check_version, int_setting, lock, today_kst};
use super::{SetupDeleteRequest, VoidOutcome};
use crate::authz::authorize_hr_org_wide;
use crate::lifecycle::title_reason::coded;
use crate::requests::reason_code;
use crate::{HrError, HrService};

impl HrService {
    /// # Errors
    /// 403 without org-wide `employee_directory_manage`; 409
    /// `phase_not_setup` after 운영 시작 (void instead);
    /// 409 `exited_register_confirmation_required`; 409 on a stale version;
    /// 404 for an unknown (or already voided) record.
    pub async fn setup_delete_employee(
        &self,
        principal: Principal,
        employee_id: Uuid,
        body: SetupDeleteRequest,
    ) -> Result<VoidOutcome, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let reason = reason_code(&body.reason_code, "reason_code")?;
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        let me = *principal.user_id.as_uuid();
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                admit(tx, org_uuid, WriteClass::SetupVoid).await?;
                let locked = lock(tx, org_uuid, employee_id).await?;
                check_version(&locked, &body.expected_updated_at)?;
                let years =
                    int_setting(tx, org_uuid, SettingKey::RetentionLaborEmployeeRegister).await?;
                let years = i32::try_from(years).map_err(|_| {
                    HrError::internal("retention.labor.employee_register is out of range")
                })?;
                let today = today_kst(tx).await?;
                check_setup_delete(locked.exit_on(), today, years, body.register_kept)
                    .map_err(coded)?;
                let mark = VoidMark {
                    voided_by: me,
                    reason_code: &reason,
                    mode: "SETUP",
                };
                let voided_at = void_in_tx(tx, org_uuid, employee_id, &mark, Some(true)).await?;
                let event = void_event(
                    &principal,
                    "employee.setup_delete",
                    employee_id,
                    json!({
                        "employee_number": locked.employee_number,
                        "status_before": &locked.status,
                        "register_kept": body.register_kept,
                        "reason_code": &reason,
                    }),
                )?;
                let outcome = VoidOutcome {
                    employee_id,
                    status: "VOIDED",
                    voided_at: Some(voided_at),
                    review_required: false,
                    pending_request: None,
                };
                Ok((outcome, vec![event]))
            })
        })
        .await
    }
}
