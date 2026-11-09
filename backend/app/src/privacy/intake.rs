// SPDX-License-Identifier: LicenseRef-Proprietary
//! Read-only tenant intake; the same Cedar placement decision admits the queue and receipt.
use super::{PrivacyState, unavailable};
use crate::http::error::ApiError;
use axum::{
    Extension, Json,
    extract::{Path, State},
    http::StatusCode,
};
use console_compliance_adapter_postgres::rights;
use console_platform_authz::{
    Principal,
    access::cedar::PRIVACY_REQUEST_INTAKE_READ,
    cedar_pbac::visible::{EmployeePlacement, load_facts},
};
use console_platform_db::insert_audit_event;
use console_platform_request_context::audit_context::access_log::{AccessRecord, access_event};
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(sqlx::FromRow)]
struct Receipt {
    body: Value,
    subject_user_id: Uuid,
    subject_name: String,
    org_unit_id: Option<Uuid>,
    workplace_id: Option<Uuid>,
    legal_entity_id: Option<Uuid>,
}

pub(super) async fn read(
    State(state): State<PrivacyState>,
    Extension(actor): Extension<Principal>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let missing = || {
        ApiError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "privacy request not found",
        )
    };
    let mut tx = rights::begin(state.store.pool(), actor.org_id)
        .await
        .map_err(unavailable)?;
    let facts = load_facts(&mut tx, actor.org_id, *actor.user_id.as_uuid())
        .await
        .map_err(unavailable)?;
    if facts
        .permitted_nodes(PRIVACY_REQUEST_INTAKE_READ)
        .map_err(unavailable)?
        .is_empty()
    {
        return Err(missing());
    }
    let row = sqlx::query_as::<_, Receipt>(concat!(
        "SELECT r.body, r.subject_user_id, p.display_name AS subject_name, e.org_unit_id, ea.workplace_id, ea.legal_entity_id ",
        "FROM privacy_rights_requests r ",
        "JOIN person_accounts_current p ON p.org_id=r.org_id AND p.id=r.subject_user_id ",
        "LEFT JOIN employees e ON e.org_id=r.org_id AND e.id=r.subject_employee_id ",
        console_hr_adapter_postgres::assignment_lateral!(),
        "WHERE r.org_id=$1 AND r.id=$2 AND r.body#>>'{receipt,controller}'='TENANT'"
    )).bind(actor.org_id.as_uuid()).bind(id).fetch_optional(tx.as_mut()).await.map_err(unavailable)?.ok_or_else(missing)?;
    let node = EmployeePlacement {
        org_unit_id: row.org_unit_id,
        workplace_id: row.workplace_id,
        legal_entity_id: row.legal_entity_id,
    }
    .node(actor.org_id, &facts);
    if !facts
        .authorize(PRIVACY_REQUEST_INTAKE_READ, node)
        .map_err(unavailable)?
    {
        return Err(missing());
    }
    let event = access_event(
        &actor,
        AccessRecord {
            action: "privacy_request.intake_read",
            target_type: "privacy_rights_request",
            target_id: id.to_string(),
            subject_ids: &[row.subject_user_id],
            reader_subject: Some(*actor.user_id.as_uuid()),
            details: json!({}),
        },
    )
    .map_err(unavailable)?;
    insert_audit_event(&mut tx, &event)
        .await
        .map_err(unavailable)?;
    tx.commit().await.map_err(unavailable)?;
    let today = console_hr_adapter_postgres::clock::today_kst();
    Ok(Json(
        json!({"request":row.body,"subject_name":row.subject_name,"as_of":today.to_string()}),
    ))
}
