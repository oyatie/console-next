// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{detail_max_length, kst_now_and_today};
use crate::{PgComplianceError, statutory::StatutoryRegister};
use console_compliance_domain::rights::{
    AgentKind, Channel, Controller, IdentityMethod, Kind, ObjectionInput, OffAppReceipt, Receipt,
    RightsRequest,
};
use console_kernel_core::{
    AuditAction, AuditEvent, KernelError, OrgId, Timestamp, TraceContext, UserId,
};
use console_platform_db::insert_audit_event;
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

async fn objection_review_days_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
) -> Result<u16, PgComplianceError> {
    use console_platform_db::settings_read::{SettingKey, resolve_in_tx};
    let key = SettingKey::PrivacyRightsObjectionReviewDays;
    let values = resolve_in_tx(tx.as_mut(), org, &[key], None, Timestamp::now_utc()).await?;
    values
        .get(&key)
        .and_then(|value| value.as_ref().ok())
        .and_then(|value| value.value.as_int())
        .and_then(|value| u16::try_from(value).ok())
        .ok_or_else(|| KernelError::internal("privacy objection review days unavailable").into())
}

/// Record an off-app privacy rights receipt on behalf of a tenant subject.
pub async fn receive_off_app(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    input: &OffAppReceipt,
    register: &StatutoryRegister,
) -> Result<Value, PgComplianceError> {
    let refuse = |code| PgComplianceError::Domain(KernelError::validation(code).with_code(code));
    if input.controller != Controller::Tenant {
        return Err(refuse("privacy_controller_invalid"));
    }
    if input.channel == Channel::InApp {
        return Err(refuse("channel_invalid"));
    }
    if input.detail.chars().count() > detail_max_length(tx, org).await? {
        return Err(refuse("detail_too_long"));
    }
    if input.kinds.iter().any(|kind| !Kind::FILING.contains(kind)) {
        return Err(refuse("request_kind_unavailable"));
    }
    let employee: Option<Option<Uuid>> =
        sqlx::query_scalar("SELECT employee_id FROM users WHERE org_id=$1 AND id=$2")
            .bind(org.as_uuid())
            .bind(input.subject_user_id)
            .fetch_optional(tx.as_mut())
            .await?;
    let Some(employee) = employee else {
        return Err(refuse("privacy_subject_not_found"));
    };
    let (now, today) = kst_now_and_today(tx).await?;
    let id = Uuid::new_v4();
    let request = RightsRequest::receive(
        Receipt {
            id,
            controller: input.controller,
            channel: input.channel,
            agent: input.agent,
            mandate_received: input.mandate_received,
            identity_method: input.identity_method,
            identity_at: now,
            received_on: input.received_on,
        },
        input.kinds.iter().copied(),
        register,
        today,
        None,
    )?;
    let mut body =
        serde_json::to_value(&request).map_err(|e| KernelError::internal(e.to_string()))?;
    body["id"] = json!(id);
    body["receipt_no"] = json!(format!("RR-{}", id.simple()));
    body["detail"] = json!(input.detail);
    body["status"] = json!(request.status());
    body["filed_by"] = json!(actor.as_uuid());
    sqlx::query("INSERT INTO privacy_rights_requests (org_id,id,subject_user_id,subject_employee_id,body) VALUES ($1,$2,$3,$4,$5)")
        .bind(org.as_uuid())
        .bind(id)
        .bind(input.subject_user_id)
        .bind(employee)
        .bind(&body)
        .execute(tx.as_mut())
        .await?;
    let event = AuditEvent::new(
        Some(actor),
        AuditAction::new("privacy_request.received")?,
        "privacy_rights_request",
        id.to_string(),
        TraceContext::generate(),
        Timestamp::now_utc(),
    )
    .with_org(org)
    .with_snapshots(
        None,
        Some(json!({
            "id": id,
            "subject_user_id": input.subject_user_id,
            "controller": input.controller,
            "channel": input.channel,
            "kinds": input.kinds,
            "off_app": true
        })),
    );
    insert_audit_event(tx, &event).await?;
    console_platform_db::command_outcomes::set_result(tx, &body).await?;
    Ok(body)
}

/// Subject and optional filer attribution for an objection filing.
pub struct ObjectionSubject {
    pub user_id: Uuid,
    pub employee_id: Option<Uuid>,
    pub filed_by: Option<Uuid>,
}

/// File a follow-up objection request referencing `original_id`.
pub async fn file_objection(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    subject: ObjectionSubject,
    original_body: &Value,
    input: &ObjectionInput,
) -> Result<Value, PgComplianceError> {
    let refuse = |code| PgComplianceError::Domain(KernelError::validation(code).with_code(code));
    if input.detail.chars().count() > detail_max_length(tx, org).await? {
        return Err(refuse("detail_too_long"));
    }
    if input.kinds.iter().any(|kind| !Kind::FILING.contains(kind)) {
        return Err(refuse("request_kind_unavailable"));
    }
    let original: RightsRequest = serde_json::from_value(original_body.clone())
        .map_err(|e| KernelError::internal(format!("stored privacy request invalid: {e}")))?;
    let review_days = objection_review_days_in_tx(tx, org).await?;
    let (now, today) = kst_now_and_today(tx).await?;
    let id = Uuid::new_v4();
    let empty_register = StatutoryRegister::new(vec![], vec![])?;
    let receipt = Receipt {
        id,
        controller: original.receipt().controller,
        channel: input.channel.unwrap_or(Channel::InApp),
        agent: input.agent.unwrap_or(AgentKind::Subject),
        mandate_received: input.mandate_received,
        identity_method: input.identity_method.unwrap_or(IdentityMethod::SignedIn),
        identity_at: now,
        received_on: input.received_on.unwrap_or(today),
    };
    let request = RightsRequest::receive(
        receipt,
        input.kinds.iter().copied(),
        &empty_register,
        today,
        Some((&original, review_days)),
    )?;
    let mut body =
        serde_json::to_value(&request).map_err(|e| KernelError::internal(e.to_string()))?;
    body["id"] = json!(id);
    body["receipt_no"] = json!(format!("RR-{}", id.simple()));
    body["detail"] = json!(input.detail);
    body["status"] = json!(request.status());
    if let Some(filer) = subject.filed_by {
        body["filed_by"] = json!(filer);
    }
    sqlx::query("INSERT INTO privacy_rights_requests (org_id,id,subject_user_id,subject_employee_id,body) VALUES ($1,$2,$3,$4,$5)")
        .bind(org.as_uuid())
        .bind(id)
        .bind(subject.user_id)
        .bind(subject.employee_id)
        .bind(&body)
        .execute(tx.as_mut())
        .await?;
    let event = AuditEvent::new(
        Some(actor),
        AuditAction::new("privacy_request.objection_received")?,
        "privacy_rights_request",
        id.to_string(),
        TraceContext::generate(),
        Timestamp::now_utc(),
    )
    .with_org(org)
    .with_snapshots(
        None,
        Some(json!({
            "id": id,
            "objection_of": original.receipt().id,
            "kinds": input.kinds,
            "review_days": review_days
        })),
    );
    insert_audit_event(tx, &event).await?;
    console_platform_db::command_outcomes::set_result(tx, &body).await?;
    Ok(body)
}
