//! IMPORT-2 (decisions #25): one employee's 주민등록번호 as HR reads it —
//! masked by default (`GET`), the full number only with a 사유 code from the
//! `rrn_reveal` domain, and every read in 접속기록. Opening the sealed value
//! takes the shell's vault; without one the reveal is 503, never a fallback.

mod govern;
mod reveal;
use console_hr_domain::{import::rrn_value::RrnVault, profile::mask};
use console_kernel_core::KernelError;
use console_platform_auth::{MobilePasskeyStepUpEnvelope, PasskeyService};
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
pub use govern::reveal_binding;
pub use reveal::{FieldRevealRequest, FieldRevealed, RevealField};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::Postgres;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::authz::{authorize_hr_person, hr_reach};
use crate::directory::access_log::{DirectoryAccess, access_event, actor_employee_id};
use crate::{HrError, HrService};

#[derive(Debug, Serialize)]
pub struct RrnStatus {
    pub employee_id: Uuid,
    pub recorded: bool,
    /// The display policy mask, independent of the legacy stored column.
    pub masked: Option<String>,
    /// `IMPORT` or `FORM`.
    pub source: Option<String>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub recorded_at: Option<OffsetDateTime>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RrnRevealRequest {
    pub reason_code: String,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub step_up: Option<MobilePasskeyStepUpEnvelope>,
}

#[derive(Serialize)]
pub struct RrnRevealed {
    pub employee_id: Uuid,
    /// `900101-1234567`.
    pub rrn: String,
    pub display_seconds: i64,
}

impl std::fmt::Debug for RrnRevealed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "RrnRevealed({})", self.employee_id)
    }
}

async fn require_employee(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    id: Uuid,
) -> Result<(), HrError> {
    let found: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM employees WHERE org_id = $1 AND id = $2)")
            .bind(org)
            .bind(id)
            .fetch_one(tx.as_mut())
            .await?;
    if found {
        Ok(())
    } else {
        Err(HrError::from_kernel(KernelError::not_found(
            "employee was not found in this organization",
        )))
    }
}

fn unavailable() -> HrError {
    HrError {
        errors: None,
        status: http::StatusCode::SERVICE_UNAVAILABLE,
        code: "rrn_vault_unavailable",
        message: "resident registration numbers cannot be opened on this server".to_owned(),
        refusals: None,
    }
}

impl HrService {
    /// The masked 주민등록번호 of an employee (접속기록: a detail read).
    pub async fn rrn_status(
        &self,
        principal: Principal,
        employee_id: Uuid,
    ) -> Result<RrnStatus, HrError> {
        hr_reach(&principal, Feature::EmployeeDirectoryManage)?;
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                authorize_hr_person(tx, &principal, Feature::EmployeeDirectoryManage, employee_id).await?;
                require_employee(tx, org_uuid, employee_id).await?;
                let row: Option<(String, String, OffsetDateTime)> = sqlx::query_as(
                    "SELECT masked, source, recorded_at FROM employee_rrn WHERE org_id = $1 AND employee_id = $2",
                )
                .bind(org_uuid)
                .bind(employee_id)
                .fetch_optional(tx.as_mut())
                .await?;
                let me = actor_employee_id(tx, &principal).await?;
                let event = access_event(&principal, DirectoryAccess::Detail, &[employee_id], me, json!({ "view": "rrn_masked" }))?;
                let status = RrnStatus {
                    employee_id,
                    recorded: row.is_some(),
                    masked: row.as_ref().map(|_| mask::rrn()),
                    source: row.as_ref().map(|r| r.1.clone()),
                    recorded_at: row.map(|r| r.2),
                };
                Ok((status, vec![event]))
            })
        })
        .await
    }

    /// The full 주민등록번호, with a 사유 code; the 접속기록 row names the code.
    ///
    /// # Errors
    /// 403 without org-wide `employee_directory_manage`; 400/422 for a reason
    /// code outside `rrn_reveal`; 404 when no number is recorded; 503 when
    /// the server has no vault.
    pub async fn rrn_reveal(
        &self,
        principal: Principal,
        employee_id: Uuid,
        request: RrnRevealRequest,
        vault: Option<&dyn RrnVault>,
        passkeys: Option<&PasskeyService>,
    ) -> Result<RrnRevealed, HrError> {
        let result = self
            .reveal_field(
                principal,
                employee_id,
                FieldRevealRequest {
                    field: RevealField::Rrn,
                    reason_code: request.reason_code,
                    note: request.note,
                    step_up: request.step_up,
                },
                vault,
                passkeys,
            )
            .await?;
        Ok(RrnRevealed {
            employee_id,
            rrn: result
                .value
                .as_str()
                .ok_or_else(|| HrError::internal("invalid RRN response"))?
                .to_owned(),
            display_seconds: result.display_seconds,
        })
    }
}
