// SPDX-License-Identifier: LicenseRef-Proprietary
//! Passkey step-up self-service reveal (`PHONE`, `ADDRESS`, `EMERGENCY_CONTACTS`)
//! with audit-before-read and `"self_read": true` isolation.

use console_kernel_core::{AuditAction, AuditEvent, KernelError, TraceContext};
use console_platform_auth::{MobilePasskeyStepUpEnvelope, PasskeyService};
use console_platform_authz::Principal;
use console_platform_db::{with_audits, with_org_conn};
use console_settings_domain::SettingKey;
use http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::certificates::self_service::require_self_employee;
use crate::import::caps::settings_in_tx;
use crate::rrn::govern::{refused, required, reveal_binding, verify_binding, within_rate};
use crate::{HrError, HrService, register_facts};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SelfRevealField {
    Phone,
    Address,
    EmergencyContacts,
}

impl SelfRevealField {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Phone => "PHONE",
            Self::Address => "ADDRESS",
            Self::EmergencyContacts => "EMERGENCY_CONTACTS",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SelfRevealRequest {
    pub field: SelfRevealField,
    #[serde(default)]
    pub step_up: Option<MobilePasskeyStepUpEnvelope>,
}

#[derive(Serialize)]
pub struct SelfFieldRevealed {
    pub employee_id: Uuid,
    pub field: SelfRevealField,
    pub value: Value,
    pub display_seconds: i64,
}

impl std::fmt::Debug for SelfFieldRevealed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "SelfFieldRevealed({}, {})",
            self.employee_id,
            self.field.as_str()
        )
    }
}

fn missing_value() -> HrError {
    HrError::from_kernel(KernelError::not_found(
        "no value is recorded for this field",
    ))
}

async fn require_self_reveal_value(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee_id: Uuid,
    user_id: Uuid,
    field: SelfRevealField,
) -> Result<(), HrError> {
    let exists: bool = match field {
        SelfRevealField::Phone => {
            sqlx::query_scalar(
                "SELECT EXISTS ( \
                     SELECT 1 FROM person_employees_current e \
                     LEFT JOIN users u ON u.org_id = e.org_id AND u.id = $3 \
                     LEFT JOIN employee_employment_profiles p ON p.org_id = e.org_id AND p.employee_id = e.id \
                     WHERE e.org_id = $1 AND e.id = $2 \
                       AND CASE WHEN console_employee_facts(e.org_id, e.id) ? 'phone' \
                                THEN NULLIF(btrim(console_employee_facts(e.org_id, e.id)->>'phone'), '') \
                                ELSE COALESCE(NULLIF(btrim(p.phone_e164), ''), NULLIF(btrim(u.phone), '')) \
                           END IS NOT NULL \
                 )",
            )
            .bind(org)
            .bind(employee_id)
            .bind(user_id)
            .fetch_one(tx.as_mut())
            .await?
        }
        SelfRevealField::Address => {
            sqlx::query_scalar(
                "SELECT EXISTS ( \
                     SELECT 1 FROM employee_register_facts f \
                     JOIN employee_addresses a ON a.org_id = f.org_id AND a.id = f.address_id \
                     WHERE f.org_id = $1 AND f.employee_id = $2 \
                 )",
            )
            .bind(org)
            .bind(employee_id)
            .fetch_one(tx.as_mut())
            .await?
        }
        SelfRevealField::EmergencyContacts => {
            sqlx::query_scalar(
                "SELECT EXISTS ( \
                     SELECT 1 FROM employee_emergency_contacts \
                     WHERE org_id = $1 AND employee_id = $2 AND voided_at IS NULL \
                 )",
            )
            .bind(org)
            .bind(employee_id)
            .fetch_one(tx.as_mut())
            .await?
        }
    };
    if exists { Ok(()) } else { Err(missing_value()) }
}

async fn read_self_reveal_value(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee_id: Uuid,
    user_id: Uuid,
    field: SelfRevealField,
) -> Result<Value, HrError> {
    let value = match field {
        SelfRevealField::Phone => {
            let phone: Option<String> = sqlx::query_scalar(
                "SELECT CASE WHEN console_employee_facts(e.org_id, e.id) ? 'phone' \
                             THEN NULLIF(btrim(console_employee_facts(e.org_id, e.id)->>'phone'), '') \
                             ELSE COALESCE(NULLIF(btrim(p.phone_e164), ''), NULLIF(btrim(u.phone), '')) \
                        END \
                 FROM person_employees_current e \
                 LEFT JOIN users u ON u.org_id = e.org_id AND u.id = $3 \
                 LEFT JOIN employee_employment_profiles p ON p.org_id = e.org_id AND p.employee_id = e.id \
                 WHERE e.org_id = $1 AND e.id = $2",
            )
            .bind(org)
            .bind(employee_id)
            .bind(user_id)
            .fetch_optional(tx.as_mut())
            .await?
            .flatten();
            json!(phone)
        }
        SelfRevealField::Address => register_facts::ledger_value(
            "address",
            register_facts::store::load_in_tx(tx, org, employee_id)
                .await?
                .address
                .as_deref(),
        ),
        SelfRevealField::EmergencyContacts => {
            let rows = sqlx::query(
                "SELECT name, relation, phone_e164 FROM employee_emergency_contacts \
                 WHERE org_id = $1 AND employee_id = $2 AND voided_at IS NULL ORDER BY seq",
            )
            .bind(org)
            .bind(employee_id)
            .fetch_all(tx.as_mut())
            .await?;
            if rows.is_empty() {
                Value::Null
            } else {
                let items: Vec<Value> = rows
                    .iter()
                    .map(|row| {
                        Ok(json!({
                            "name": row.try_get::<String, _>("name")?,
                            "relation": row.try_get::<String, _>("relation")?,
                            "phone": row.try_get::<String, _>("phone_e164")?,
                        }))
                    })
                    .collect::<Result<Vec<_>, sqlx::Error>>()?;
                Value::Array(items)
            }
        }
    };
    if value.is_null() {
        Err(missing_value())
    } else {
        Ok(value)
    }
}

impl HrService {
    pub async fn reveal_me_profile_field(
        &self,
        principal: Principal,
        request: SelfRevealRequest,
        passkeys: Option<&PasskeyService>,
    ) -> Result<SelfFieldRevealed, HrError> {
        if principal.support.is_some() {
            return Err(refused(
                StatusCode::FORBIDDEN,
                "support_session_read_only",
                "support sessions cannot reveal self-service personal fields",
            ));
        }
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        let user_uuid = *principal.user_id.as_uuid();
        let field = request.field;
        let step_up = request.step_up;
        let passkeys = passkeys.cloned();
        let authorized = principal.clone();

        let (employee_id, display_seconds) =
            with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
                Box::pin(async move {
                    let (_, employee_id) = require_self_employee(tx, &authorized).await?;
                    let within = within_rate(
                        tx,
                        &authorized,
                        &[
                            "employee.self_reveal",
                            "employee.rrn_reveal",
                            "employee.field_reveal",
                        ],
                    )
                    .await?;
                    if !within {
                        return Err(refused(
                            StatusCode::TOO_MANY_REQUESTS,
                            "reveal_rate_limited",
                            "retry after the oldest reveal leaves the rolling one-hour window",
                        ));
                    }
                    match (step_up, passkeys.as_ref()) {
                        (Some(proof), Some(passkeys)) => {
                            verify_binding(
                                tx,
                                &authorized,
                                reveal_binding(employee_id, "SELF_REVEAL", field.as_str()),
                                proof,
                                passkeys,
                            )
                            .await?;
                        }
                        _ => return Err(required()),
                    }
                    require_self_reveal_value(tx, org_uuid, employee_id, user_uuid, field).await?;
                    let settings =
                        settings_in_tx(tx, org_uuid, &[SettingKey::PrivacyRevealDisplaySeconds])
                            .await?;
                    let display_seconds = settings
                        .get(&SettingKey::PrivacyRevealDisplaySeconds)
                        .and_then(|v| v.as_int())
                        .ok_or_else(|| HrError::internal("reveal policy did not resolve"))?;
                    let event = AuditEvent::new(
                        Some(authorized.user_id),
                        AuditAction::new("employee.self_reveal").map_err(HrError::from_kernel)?,
                        "employee",
                        employee_id.to_string(),
                        TraceContext::generate(),
                        OffsetDateTime::now_utc(),
                    )
                    .with_org(org)
                    .with_snapshots(
                        None,
                        Some(json!({
                            "self_read": true,
                            "employee_id": employee_id,
                            "field": field.as_str(),
                        })),
                    );
                    Ok(((employee_id, display_seconds), vec![event]))
                })
            })
            .await?;

        // Audit-before-read: plaintext is loaded in a separate transaction only
        // after the immutable audit event has committed.
        let value = with_org_conn::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let (_, checked_employee_id) = require_self_employee(tx, &principal).await?;
                if checked_employee_id != employee_id {
                    return Err(refused(
                        StatusCode::FORBIDDEN,
                        "forbidden",
                        "self-service employee binding changed",
                    ));
                }
                read_self_reveal_value(tx, org_uuid, employee_id, user_uuid, field).await
            })
        })
        .await?;

        Ok(SelfFieldRevealed {
            employee_id,
            field,
            value,
            display_seconds,
        })
    }
}
