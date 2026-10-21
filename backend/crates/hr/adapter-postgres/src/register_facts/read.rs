//! `GET /employees/{id}/register-facts`: the 근로자 명부 items HR holds for one
//! employee (성별, 주소, 이력 · 경력, 퇴직 사유, 그 밖에 필요한 사항). They are
//! personal data an employee-directory reader does not see, so the read needs
//! `employee_directory_manage` (as the register export does) and leaves a
//! 접속기록 row like the detail read.

use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use serde::Serialize;
use serde_json::{Value, json};
use time::OffsetDateTime;
use uuid::Uuid;

use super::ledger_value;
use super::store::load_in_tx;
use crate::authz::authorize_hr_org_wide;
use crate::directory::access_log::{DirectoryAccess, access_event, actor_employee_id};
use crate::{HrError, HrService};

#[derive(Debug, Serialize)]
pub struct RegisterFactsResponse {
    pub employee_id: Uuid,
    /// The employee's version: send it as `expected_updated_at` with the
    /// `PATCH /employees/{id}` that corrects these items.
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    /// `MALE` | `FEMALE`; null = 미입력.
    pub sex: Option<String>,
    /// The structured address (`KrAddress`); null = 미입력.
    pub address: Value,
    /// Null = 미입력; `[]` = 경력 없음.
    pub careers: Value,
    pub exit_reason_code: Option<String>,
    /// The register label of the code (system label or the tenant's).
    pub exit_reason_label: Option<String>,
    pub register_note: Option<String>,
}

impl HrService {
    pub async fn register_facts(
        &self,
        principal: Principal,
        employee_id: Uuid,
    ) -> Result<RegisterFactsResponse, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let updated_at: OffsetDateTime = sqlx::query_scalar(
                    "SELECT updated_at FROM employees WHERE org_id = $1 AND id = $2",
                )
                .bind(org_uuid)
                .bind(employee_id)
                .fetch_optional(tx.as_mut())
                .await?
                .ok_or_else(|| {
                    HrError::from_kernel(console_kernel_core::KernelError::not_found(
                        "employee was not found in this organization",
                    ))
                })?;
                let row = load_in_tx(tx, org_uuid, employee_id).await?;
                let me = actor_employee_id(tx, &principal).await?;
                let event = access_event(
                    &principal,
                    DirectoryAccess::Detail,
                    &[employee_id],
                    me,
                    json!({ "view": "register_facts" }),
                )?;
                let response = RegisterFactsResponse {
                    employee_id,
                    updated_at,
                    sex: row.sex,
                    address: ledger_value("address", row.address.as_deref()),
                    careers: ledger_value("careers", row.careers.as_deref()),
                    exit_reason_code: row.exit_reason_code,
                    exit_reason_label: row.exit_reason_label,
                    register_note: row.register_note,
                };
                Ok((response, vec![event]))
            })
        })
        .await
    }
}
