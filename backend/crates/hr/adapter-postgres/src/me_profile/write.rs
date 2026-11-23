// SPDX-License-Identifier: LicenseRef-Proprietary
use http::StatusCode;
use serde_json::{Value, json};
use time::OffsetDateTime;

use console_hr_domain::requests::ChangeRequestKind;
use console_kernel_core::{AuditAction, AuditEvent, TraceContext};
use console_platform_authz::Principal;
use console_platform_db::with_audits;

use super::{
    CreateSelfChangeRequest, MeProfileResponse, SelfChangeRequestField, UpdateMeProfileRequest,
    load_profile_in_tx, self_audit,
};
use crate::certificates::self_service::require_self_employee;
use crate::corrections::{lock_employee, normalize_value};
use crate::directory::normalize::normalize_phone_e164;
use crate::requests::ChangeRequestResponse;
use crate::requests::create::{NewChangeRequest, insert_change_request_in_tx};
use crate::rrn::govern::refused;
use crate::{HrError, HrService, personal_facts, register_facts};

impl HrService {
    pub async fn update_me_profile(
        &self,
        principal: Principal,
        body: UpdateMeProfileRequest,
    ) -> Result<MeProfileResponse, HrError> {
        if principal.support.is_some() {
            return Err(refused(
                StatusCode::FORBIDDEN,
                "support_session_read_only",
                "support sessions cannot modify self-service profile fields",
            ));
        }
        if body.phone.is_none() && body.emergency_contacts.is_none() {
            return Err(HrError::validation(
                "provide at least one of phone or emergency_contacts to update",
            ));
        }
        let next_phone: Option<Option<String>> = match body.phone {
            None => None,
            Some(None) => Some(None),
            Some(Some(raw)) => {
                if raw.contains('•') || raw.contains('●') {
                    return Err(HrError::validation("phone must not be a masked value"));
                }
                let trimmed = raw.trim();
                if trimmed.is_empty() {
                    Some(None)
                } else {
                    Some(Some(normalize_phone_e164(trimmed.to_owned())?))
                }
            }
        };
        let next_contacts = body
            .emergency_contacts
            .map(|contacts| {
                let value = serde_json::to_value(contacts).map_err(|_| {
                    HrError::validation("emergency_contacts could not be serialized")
                })?;
                personal_facts::normalize("emergency_contacts", &value)
            })
            .transpose()?;

        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        let user_uuid = *principal.user_id.as_uuid();
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let (_, employee_id) = require_self_employee(tx, &principal).await?;
                let head = lock_employee(tx, org_uuid, employee_id).await?;
                let mut updated_fields: Vec<&'static str> = Vec::new();

                if let Some(phone_val) = next_phone {
                    let old_phone = head.current("phone").map(|s| json!(s));
                    let person_id: uuid::Uuid = match sqlx::query_scalar::<_, Option<uuid::Uuid>>(
                        "SELECT console_employee_person($1, $2)",
                    )
                    .bind(org_uuid)
                    .bind(employee_id)
                    .fetch_one(tx.as_mut())
                    .await?
                    {
                        Some(id) => id,
                        None => {
                            sqlx::query_scalar("SELECT console_bind_employee_person($1, $2, $3)")
                                .bind(org_uuid)
                                .bind(employee_id)
                                .bind(user_uuid)
                                .fetch_one(tx.as_mut())
                                .await?
                        }
                    };
                    sqlx::query(
                        "SELECT console_revise_person_facts($1, $2, jsonb_build_object('phone', $3::text), $4)",
                    )
                    .bind(org_uuid)
                    .bind(person_id)
                    .bind(phone_val.as_deref())
                    .bind(user_uuid)
                    .execute(tx.as_mut())
                    .await?;
                    sqlx::query(
                        "INSERT INTO employee_corrections \
                         (org_id, employee_id, field, old_value, new_value, reason_code, corrected_by) \
                         VALUES ($1, $2, 'phone', $3, $4, 'SELF_SERVICE', $5)",
                    )
                    .bind(org_uuid)
                    .bind(employee_id)
                    .bind(old_phone)
                    .bind(json!(phone_val))
                    .bind(user_uuid)
                    .execute(tx.as_mut())
                    .await?;
                    updated_fields.push("phone");
                }

                if let Some(contacts_json) = next_contacts {
                    let old_contacts = head
                        .current("emergency_contacts")
                        .map(|raw| personal_facts::ledger_value("emergency_contacts", Some(raw)));
                    personal_facts::store::write_in_tx(
                        tx,
                        org_uuid,
                        employee_id,
                        &[("emergency_contacts", contacts_json.as_deref())],
                        user_uuid,
                    )
                    .await?;
                    let stored_contacts = personal_facts::store::load_in_tx(tx, org_uuid, employee_id)
                        .await?
                        .emergency_contacts;
                    let new_contacts = personal_facts::ledger_value(
                        "emergency_contacts",
                        stored_contacts.as_deref(),
                    );
                    sqlx::query(
                        "INSERT INTO employee_corrections \
                         (org_id, employee_id, field, old_value, new_value, reason_code, corrected_by) \
                         VALUES ($1, $2, 'emergency_contacts', $3, $4, 'SELF_SERVICE', $5)",
                    )
                    .bind(org_uuid)
                    .bind(employee_id)
                    .bind(old_contacts)
                    .bind(new_contacts)
                    .bind(user_uuid)
                    .execute(tx.as_mut())
                    .await?;
                    updated_fields.push("emergency_contacts");
                }

                let profile = load_profile_in_tx(tx, org_uuid, user_uuid, employee_id).await?;
                let event = self_audit(
                    &principal,
                    "employee.self_profile_update",
                    employee_id,
                    json!({
                        "employee_id": employee_id,
                        "fields": updated_fields,
                    }),
                )?;
                Ok((profile, vec![event]))
            })
        })
        .await
    }

    pub async fn create_me_profile_change_request(
        &self,
        principal: Principal,
        body: CreateSelfChangeRequest,
    ) -> Result<ChangeRequestResponse, HrError> {
        if principal.support.is_some() {
            return Err(refused(
                StatusCode::FORBIDDEN,
                "support_session_read_only",
                "support sessions cannot file profile change requests",
            ));
        }
        let field_name = body.field.as_str();
        let normalized_change_value = match body.field {
            SelfChangeRequestField::Address => {
                if body.bank_account_registered.is_some() {
                    return Err(HrError::validation(
                        "bank_account_registered must not be sent for an address request",
                    ));
                }
                let raw = body
                    .address
                    .as_ref()
                    .filter(|v| !v.is_null())
                    .ok_or_else(|| HrError::validation("address is required"))?;
                let normalized = register_facts::normalize("address", raw)?
                    .ok_or_else(|| HrError::validation("address is required"))?;
                serde_json::from_str::<Value>(&normalized)
                    .map_err(|_| HrError::validation("address must be a valid address object"))?
            }
            SelfChangeRequestField::BankAccountRegistered => {
                if body.address.is_some() {
                    return Err(HrError::validation(
                        "address must not be sent for a bank_account_registered request",
                    ));
                }
                let flag = body.bank_account_registered.ok_or_else(|| {
                    HrError::validation("bank_account_registered boolean is required")
                })?;
                normalize_value("bank_account_registered", &json!(flag))?;
                json!(flag)
            }
        };
        let note = body
            .note
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| {
                if s.chars().count() > 500 || s.chars().any(char::is_control) {
                    Err(HrError::validation(
                        "note must be 500 characters or fewer without control characters",
                    ))
                } else {
                    Ok(s.to_owned())
                }
            })
            .transpose()?;

        let payload = json!({ "changes": { field_name: normalized_change_value } });
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        let user_uuid = *principal.user_id.as_uuid();

        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let (_, employee_id) = require_self_employee(tx, &principal).await?;
                let duplicate: bool = sqlx::query_scalar(
                    "SELECT EXISTS ( \
                         SELECT 1 FROM change_requests \
                         WHERE org_id = $1 AND kind = 'PROFILE_CORRECTION' \
                           AND subject_type = 'EMPLOYEE' AND subject_id = $2 \
                           AND status = 'OPEN' AND (payload->'changes') ? $3 \
                     )",
                )
                .bind(org_uuid)
                .bind(employee_id)
                .bind(field_name)
                .fetch_one(tx.as_mut())
                .await?;
                if duplicate {
                    return Err(refused(
                        StatusCode::CONFLICT,
                        "change_request_already_open",
                        "an open change request for this field is already pending review",
                    ));
                }
                let created = insert_change_request_in_tx(
                    tx,
                    NewChangeRequest {
                        org: org_uuid,
                        kind: ChangeRequestKind::ProfileCorrection,
                        subject_type: "EMPLOYEE",
                        subject_id: employee_id,
                        payload: &payload,
                        reason_code: "SELF_SERVICE",
                        note: note.as_deref(),
                        requested_by: user_uuid,
                        assignee_user_id: None,
                    },
                )
                .await?;
                let event = AuditEvent::new(
                    Some(principal.user_id),
                    AuditAction::new("change_request.create").map_err(HrError::from_kernel)?,
                    "change_request",
                    created.id.to_string(),
                    TraceContext::generate(),
                    OffsetDateTime::now_utc(),
                )
                .with_org(org)
                .with_snapshots(
                    None,
                    Some(json!({
                        "self_read": true,
                        "kind": "PROFILE_CORRECTION",
                        "subject_id": employee_id,
                        "field": field_name,
                    })),
                );
                Ok((created, vec![event]))
            })
        })
        .await
    }
}
