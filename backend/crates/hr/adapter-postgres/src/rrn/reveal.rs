// SPDX-License-Identifier: LicenseRef-Proprietary
//! One governed reveal for every personal field; the access record commits before reading the value.
use super::{govern, require_employee, unavailable};
use crate::{
    HrError, HrService,
    authz::authorize_hr_person,
    directory::access_log::{DirectoryAccess, access_event, actor_employee_id},
    import::identities::sealed_from_row,
};
use console_hr_domain::import::rrn_value::{RrnVault, SealedRrn};
use console_kernel_core::KernelError;
use console_platform_auth::{MobilePasskeyStepUpEnvelope, PasskeyService};
use console_platform_authz::{Feature, Principal};
use console_platform_db::{with_audits, with_org_conn};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RevealField {
    Rrn,
    BirthDate,
    Address,
    Phone,
    PersonalEmail,
}
impl RevealField {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Rrn => "RRN",
            Self::BirthDate => "BIRTH_DATE",
            Self::Address => "ADDRESS",
            Self::Phone => "PHONE",
            Self::PersonalEmail => "PERSONAL_EMAIL",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FieldRevealRequest {
    pub field: RevealField,
    pub reason_code: String,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub step_up: Option<MobilePasskeyStepUpEnvelope>,
}

#[derive(Serialize)]
pub struct FieldRevealed {
    pub employee_id: Uuid,
    pub field: RevealField,
    pub value: Value,
    pub display_seconds: i64,
}
impl std::fmt::Debug for FieldRevealed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "FieldRevealed({})", self.employee_id)
    }
}

impl HrService {
    pub async fn reveal_field(
        &self,
        principal: Principal,
        employee: Uuid,
        request: FieldRevealRequest,
        vault: Option<&dyn RrnVault>,
        passkeys: Option<&PasskeyService>,
    ) -> Result<FieldRevealed, HrError> {
        let org = principal.org_id;
        let field = request.field;
        let vault_available = vault.is_some();
        let authorized = principal.clone();
        let passkeys = passkeys.cloned();
        let seconds = with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let code = request.reason_code.trim().to_owned();
                let note_given = request.note.is_some();
                let seconds =
                    govern::authorize(tx, &authorized, employee, request, passkeys.as_ref())
                        .await?;
                require_employee(tx, *org.as_uuid(), employee).await?;
                if field == RevealField::Rrn && !vault_available {
                    return Err(unavailable());
                }
                require_value(tx, *org.as_uuid(), employee, field).await?;
                let access = if field == RevealField::Rrn {
                    DirectoryAccess::RrnReveal
                } else {
                    DirectoryAccess::FieldReveal
                };
                let me = actor_employee_id(tx, &authorized).await?;
                let event = access_event(
                    &authorized,
                    access,
                    &[employee],
                    me,
                    json!({"field":field,"reason_code":code,"note_given":note_given}),
                )?;
                Ok((seconds, vec![event]))
            })
        })
        .await?;
        // No plaintext or sealed value is loaded until the access record is durable.
        let value = with_org_conn::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                authorize_hr_person(tx, &principal, Feature::EmployeeDirectoryManage, employee)
                    .await?;
                read_value(tx, *org.as_uuid(), employee, field).await
            })
        })
        .await?;
        let value = match value {
            ReadValue::Rrn(sealed) => {
                let rrn = vault
                    .ok_or_else(unavailable)?
                    .open(*org.as_uuid(), &sealed)
                    .map_err(|_| unavailable())?;
                let digits = rrn.digits();
                json!(format!("{}-{}", &digits[..6], &digits[6..]))
            }
            ReadValue::Field(value) => value,
        };
        metrics::counter!("hr_employee_pii_total", "operation"=>"reveal", "outcome"=>"allowed")
            .increment(1);
        Ok(FieldRevealed {
            employee_id: employee,
            field,
            value,
            display_seconds: seconds,
        })
    }
}

enum ReadValue {
    Rrn(SealedRrn),
    Field(Value),
}

// Probe presence only: neither plaintext nor ciphertext may be loaded before the access record commits.
async fn require_value(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee: Uuid,
    field: RevealField,
) -> Result<(), HrError> {
    let sql = match field {
        RevealField::Rrn => {
            "SELECT EXISTS(SELECT 1 FROM employee_rrn WHERE org_id=$1 AND employee_id=$2)"
        }
        RevealField::BirthDate => {
            "SELECT EXISTS(SELECT 1 FROM person_employees_current WHERE org_id=$1 AND id=$2 AND birth_date IS NOT NULL)"
        }
        RevealField::Address => {
            "SELECT EXISTS(SELECT 1 FROM employee_register_facts f JOIN employee_addresses a ON a.org_id=f.org_id AND a.id=f.address_id WHERE f.org_id=$1 AND f.employee_id=$2)"
        }
        RevealField::Phone => {
            "SELECT EXISTS(SELECT 1 FROM person_employees_current e LEFT JOIN employee_employment_profiles p ON p.org_id=e.org_id AND p.employee_id=e.id WHERE e.org_id=$1 AND e.id=$2 AND (CASE WHEN console_employee_facts(e.org_id,e.id) ? 'phone' THEN console_employee_facts(e.org_id,e.id)->>'phone' ELSE p.phone_e164 END) IS NOT NULL)"
        }
        RevealField::PersonalEmail => {
            "SELECT EXISTS(SELECT 1 FROM employee_personal_facts WHERE org_id=$1 AND employee_id=$2 AND personal_email IS NOT NULL)"
        }
    };
    if sqlx::query_scalar::<_, bool>(sql)
        .bind(org)
        .bind(employee)
        .fetch_one(tx.as_mut())
        .await?
    {
        Ok(())
    } else {
        Err(missing())
    }
}

async fn read_value(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee: Uuid,
    field: RevealField,
) -> Result<ReadValue, HrError> {
    let value = match field {
        RevealField::Rrn => {
            let row=sqlx::query("SELECT rrn_hmac,hmac_key_version,ciphertext,nonce,dek_wrapped,dek_nonce,key_version,masked FROM employee_rrn WHERE org_id=$1 AND employee_id=$2")
                .bind(org).bind(employee).fetch_optional(tx.as_mut()).await?.ok_or_else(missing)?;
            return Ok(ReadValue::Rrn(sealed_from_row(&row)?));
        }
        RevealField::BirthDate => json!(
            crate::profile::load_facts(tx, org, employee, false)
                .await?
                .birth_date
        ),
        RevealField::Address => crate::register_facts::ledger_value(
            "address",
            crate::register_facts::store::load_in_tx(tx, org, employee)
                .await?
                .address
                .as_deref(),
        ),
        RevealField::PersonalEmail => json!(
            crate::personal_facts::store::load_in_tx(tx, org, employee)
                .await?
                .personal_email
        ),
        RevealField::Phone => {
            let phone:Option<String>=sqlx::query_scalar("SELECT CASE WHEN console_employee_facts(e.org_id,e.id) ? 'phone' THEN console_employee_facts(e.org_id,e.id)->>'phone' ELSE p.phone_e164 END FROM person_employees_current e LEFT JOIN employee_employment_profiles p ON p.org_id=e.org_id AND p.employee_id=e.id WHERE e.org_id=$1 AND e.id=$2")
                .bind(org).bind(employee).fetch_optional(tx.as_mut()).await?.flatten();
            json!(phone)
        }
    };
    if value.is_null() {
        Err(missing())
    } else {
        Ok(ReadValue::Field(value))
    }
}
fn missing() -> HrError {
    HrError::from_kernel(KernelError::not_found(
        "no value is recorded for this field",
    ))
}
