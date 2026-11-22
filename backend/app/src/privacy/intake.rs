// SPDX-License-Identifier: LicenseRef-Proprietary
//! Tenant intake listing, reading, and off-app receipt recording under Cedar placement.
use super::{PrivacyState, store_error, unavailable};
use crate::http::error::ApiError;
use axum::{
    Extension, Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use console_compliance_adapter_postgres::rights::{self, OffAppReceipt, Status};
use console_platform_authz::{
    Feature, Principal,
    access::cedar::PRIVACY_REQUEST_INTAKE_READ,
    cedar_pbac::visible::{EmployeePlacement, load_facts},
};
use console_platform_db::insert_audit_event;
use console_platform_request_context::audit_context::access_log::{AccessRecord, access_event};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(sqlx::FromRow)]
pub(super) struct Receipt {
    pub(super) id: Uuid,
    pub(super) body: Value,
    pub(super) subject_user_id: Uuid,
    pub(super) subject_name: String,
    pub(super) org_unit_id: Option<Uuid>,
    pub(super) workplace_id: Option<Uuid>,
    pub(super) legal_entity_id: Option<Uuid>,
}

#[derive(sqlx::FromRow)]
struct SubjectPlacementRow {
    org_unit_id: Option<Uuid>,
    workplace_id: Option<Uuid>,
    legal_entity_id: Option<Uuid>,
}

#[derive(Deserialize)]
pub(super) struct ListQuery {
    cursor: Option<String>,
    status: Option<Status>,
}

pub(super) fn missing() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "not_found",
        "privacy request not found",
    )
}

pub(super) fn forbidden(code: &'static str, message: &'static str) -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, code, message)
}

pub(super) async fn list(
    State(state): State<PrivacyState>,
    Extension(actor): Extension<Principal>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let cursor = query
        .cursor
        .as_deref()
        .map(Uuid::parse_str)
        .transpose()
        .map_err(|_| {
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "cursor_invalid",
                "invalid cursor",
            )
        })?;
    let status_filter = query
        .status
        .map(|s| match s {
            Status::Received => "RECEIVED",
            Status::Decided => "DECIDED",
        })
        .map(str::to_owned);

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
        return Err(forbidden("forbidden", "privacy intake read refused"));
    }

    let rows = sqlx::query_as::<_, Receipt>(concat!(
        "SELECT r.id, r.body, r.subject_user_id, p.display_name AS subject_name, e.org_unit_id, ea.workplace_id, ea.legal_entity_id ",
        "FROM privacy_rights_requests r ",
        "JOIN person_accounts_current p ON p.org_id=r.org_id AND p.id=r.subject_user_id ",
        "LEFT JOIN employees e ON e.org_id=r.org_id AND e.id=r.subject_employee_id ",
        console_hr_adapter_postgres::assignment_lateral!(),
        "WHERE r.org_id=$1 AND r.body#>>'{receipt,controller}'='TENANT' ",
        "AND ($2::uuid IS NULL OR r.id < $2) ",
        "AND ($3::text IS NULL OR r.body->>'status' = $3) ",
        "ORDER BY r.id DESC"
    ))
    .bind(actor.org_id.as_uuid())
    .bind(cursor)
    .bind(status_filter)
    .fetch_all(tx.as_mut())
    .await
    .map_err(unavailable)?;

    const LIMIT: usize = 50;
    let mut visible_rows = Vec::new();
    for row in rows {
        let node = EmployeePlacement {
            org_unit_id: row.org_unit_id,
            workplace_id: row.workplace_id,
            legal_entity_id: row.legal_entity_id,
        }
        .node(actor.org_id, &facts);
        if facts
            .authorize(PRIVACY_REQUEST_INTAKE_READ, node)
            .map_err(unavailable)?
        {
            visible_rows.push(row);
            if visible_rows.len() > LIMIT {
                break;
            }
        }
    }
    let more = visible_rows.len() > LIMIT;
    if more {
        visible_rows.pop();
    }
    let next_cursor = more
        .then(|| visible_rows.last().map(|r| r.id.to_string()))
        .flatten();
    let subject_ids: Vec<Uuid> = visible_rows.iter().map(|r| r.subject_user_id).collect();
    let items: Vec<Value> = visible_rows
        .into_iter()
        .map(|row| json!({ "request": row.body, "subject_name": row.subject_name }))
        .collect();
    let event = access_event(
        &actor,
        AccessRecord {
            action: "privacy_request.intake_listed",
            target_type: "privacy_rights_request",
            target_id: "query".to_owned(),
            subject_ids: &subject_ids,
            reader_subject: Some(*actor.user_id.as_uuid()),
            details: json!({ "count": items.len() }),
        },
    )
    .map_err(unavailable)?;
    insert_audit_event(&mut tx, &event)
        .await
        .map_err(unavailable)?;
    tx.commit().await.map_err(unavailable)?;
    let today = console_hr_adapter_postgres::clock::today_kst();
    Ok(Json(json!({
        "items": items,
        "next_cursor": next_cursor,
        "as_of": today.to_string(),
    })))
}

pub(super) async fn read(
    State(state): State<PrivacyState>,
    Extension(actor): Extension<Principal>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
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
        "SELECT r.id, r.body, r.subject_user_id, p.display_name AS subject_name, e.org_unit_id, ea.workplace_id, ea.legal_entity_id ",
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

pub(super) async fn receive_off_app(
    State(state): State<PrivacyState>,
    Extension(actor): Extension<Principal>,
    Json(input): Json<OffAppReceipt>,
) -> Result<Json<Value>, ApiError> {
    let mut tx = rights::begin(state.store.pool(), actor.org_id)
        .await
        .map_err(unavailable)?;
    let facts = load_facts(&mut tx, actor.org_id, *actor.user_id.as_uuid())
        .await
        .map_err(unavailable)?;
    if facts
        .permitted_nodes(Feature::PrivacyRequestDecide.as_str())
        .map_err(unavailable)?
        .is_empty()
    {
        return Err(forbidden("forbidden", "privacy intake receive refused"));
    }
    let placement = sqlx::query_as::<_, SubjectPlacementRow>(concat!(
        "SELECT e.org_unit_id, ea.workplace_id, ea.legal_entity_id ",
        "FROM users u ",
        "LEFT JOIN employees e ON e.org_id=u.org_id AND e.id=u.employee_id ",
        console_hr_adapter_postgres::assignment_lateral!(),
        "WHERE u.org_id=$1 AND u.id=$2"
    ))
    .bind(actor.org_id.as_uuid())
    .bind(input.subject_user_id)
    .fetch_optional(tx.as_mut())
    .await
    .map_err(unavailable)?
    .ok_or_else(missing)?;
    let node = EmployeePlacement {
        org_unit_id: placement.org_unit_id,
        workplace_id: placement.workplace_id,
        legal_entity_id: placement.legal_entity_id,
    }
    .node(actor.org_id, &facts);
    if !facts
        .authorize(Feature::PrivacyRequestDecide.as_str(), node)
        .map_err(unavailable)?
    {
        return Err(missing());
    }
    let register = state
        .store
        .statutory_register()
        .await
        .map_err(unavailable)?;
    let body = rights::receive_off_app(&mut tx, actor.org_id, actor.user_id, &input, &register)
        .await
        .map_err(store_error)?;
    tx.commit().await.map_err(unavailable)?;
    Ok(Json(body))
}
