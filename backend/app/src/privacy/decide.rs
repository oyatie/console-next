// SPDX-License-Identifier: LicenseRef-Proprietary
//! Privacy rights decision, postponement step-up SoD, and objection intake.
use super::intake::{Receipt, forbidden, missing};
use super::{PrivacyState, store_error, unavailable};
use crate::http::error::ApiError;
use axum::{
    Extension, Json,
    extract::{Path, State},
    http::StatusCode,
};
use console_compliance_adapter_postgres::rights::{
    self, DecideInput, Kind, ObjectionInput, Outcome, PostponeInput, wire_date,
};
use console_platform_auth::{
    MobilePasskeyStepUpBinding, MobilePasskeyStepUpEnvelope, MobileStepUpActionKind,
};
use console_platform_authz::{
    Feature, Principal,
    cedar_pbac::{
        actions::independent_people,
        visible::{EmployeePlacement, load_facts},
    },
};
use serde::Deserialize;
use serde_json::Value;
use time::Date;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct DecideBody {
    kind: Kind,
    outcome: Outcome,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    note: Option<String>,
    #[serde(default, with = "wire_date::option")]
    decided_on: Option<Date>,
    step_up: Option<MobilePasskeyStepUpEnvelope>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PostponeBody {
    kind: Kind,
    reason: String,
    note: String,
    #[serde(default, with = "wire_date::option")]
    decided_on: Option<Date>,
    step_up: Option<MobilePasskeyStepUpEnvelope>,
}

async fn verify_decide_step_up(
    state: &PrivacyState,
    actor: &Principal,
    id: Uuid,
    payload_hash: String,
    step_up: Option<MobilePasskeyStepUpEnvelope>,
) -> Result<(), ApiError> {
    let step_up = step_up.ok_or_else(|| {
        forbidden(
            "passkey_step_up_required",
            "a fresh passkey assertion is required",
        )
    })?;
    let verifier = state.passkey_step_up.as_ref().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "passkey verification unavailable",
        )
    })?;
    let binding = MobilePasskeyStepUpBinding::bound(
        MobileStepUpActionKind::PrivacyRequestDecide,
        id,
        payload_hash,
    );
    verifier
        .verify_mobile_step_up_for_user(
            state.store.pool(),
            step_up,
            *actor.user_id.as_uuid(),
            &binding,
        )
        .await
        .map_err(|_| forbidden("passkey_step_up_failed", "passkey verification failed"))
}

async fn authorize_decision_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    actor: &Principal,
    id: Uuid,
    kind: Kind,
) -> Result<Receipt, ApiError> {
    let facts = load_facts(tx, actor.org_id, *actor.user_id.as_uuid())
        .await
        .map_err(unavailable)?;
    let row = sqlx::query_as::<_, Receipt>(concat!(
        "SELECT r.id, r.body, r.subject_user_id, p.display_name AS subject_name, e.org_unit_id, ea.workplace_id, ea.legal_entity_id ",
        "FROM privacy_rights_requests r ",
        "JOIN person_accounts_current p ON p.org_id=r.org_id AND p.id=r.subject_user_id ",
        "LEFT JOIN employees e ON e.org_id=r.org_id AND e.id=r.subject_employee_id ",
        console_hr_adapter_postgres::assignment_lateral!(),
        "WHERE r.org_id=$1 AND r.id=$2 AND r.body#>>'{receipt,controller}'='TENANT' ",
        "FOR UPDATE OF r"
    ))
    .bind(actor.org_id.as_uuid())
    .bind(id)
    .fetch_optional(tx.as_mut())
    .await
    .map_err(unavailable)?
    .ok_or_else(missing)?;
    let node = EmployeePlacement {
        org_unit_id: row.org_unit_id,
        workplace_id: row.workplace_id,
        legal_entity_id: row.legal_entity_id,
    }
    .node(actor.org_id, &facts);
    if !facts
        .authorize(Feature::PrivacyRequestDecide.as_str(), node)
        .map_err(unavailable)?
    {
        return Err(missing());
    }
    let filed_by = row
        .body
        .get("filed_by")
        .and_then(Value::as_str)
        .and_then(|s| Uuid::parse_str(s).ok());
    let objection_of = row
        .body
        .get("objection_of")
        .and_then(Value::as_str)
        .and_then(|s| Uuid::parse_str(s).ok());
    let original_decided_by = if let Some(orig_id) = objection_of {
        let orig_body: Option<Value> = sqlx::query_scalar(
            "SELECT body FROM privacy_rights_requests WHERE org_id=$1 AND id=$2",
        )
        .bind(actor.org_id.as_uuid())
        .bind(orig_id)
        .fetch_optional(tx.as_mut())
        .await
        .map_err(unavailable)?;
        let kind_key = serde_json::to_value(kind)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned));
        orig_body.and_then(|body| {
            kind_key
                .as_deref()
                .and_then(|k| body.get("decided_by_kind").and_then(|m| m.get(k)))
                .or_else(|| body.get("decided_by"))
                .and_then(Value::as_str)
                .and_then(|s| Uuid::parse_str(s).ok())
        })
    } else {
        None
    };

    let (allowed, reasons) = facts
        .authorize_privacy_request_decide(node, row.subject_user_id, filed_by, original_decided_by)
        .map_err(unavailable)?;
    if !allowed {
        let code = if reasons.iter().any(|r| r == "objection_same_decider") {
            "objection_same_decider"
        } else if reasons.iter().any(|r| r == "own_request_forbidden") {
            "own_request_forbidden"
        } else {
            "forbidden"
        };
        return Err(forbidden(code, "privacy request decision refused"));
    }

    let checker = *actor.user_id.as_uuid();
    if let Some(refusal) =
        independent_people::refusal_in_tx(tx.as_mut(), Some(row.subject_user_id), checker).await
    {
        return Err(forbidden(
            refusal.code("privacy.refuse.identity_unbound", "own_request_forbidden"),
            "privacy request decision requires an independent person",
        ));
    }
    if let Some(filer) = filed_by.filter(|f| *f != row.subject_user_id)
        && let Some(refusal) =
            independent_people::refusal_in_tx(tx.as_mut(), Some(filer), checker).await
    {
        return Err(forbidden(
            refusal.code("privacy.refuse.identity_unbound", "own_request_forbidden"),
            "privacy request decision requires an independent person",
        ));
    }
    if let Some(orig_decider) = original_decided_by
        && let Some(refusal) =
            independent_people::refusal_in_tx(tx.as_mut(), Some(orig_decider), checker).await
    {
        return Err(forbidden(
            refusal.code("privacy.refuse.identity_unbound", "objection_same_decider"),
            "objection decision requires another person than the original decider",
        ));
    }
    Ok(row)
}

pub(super) async fn decide(
    State(state): State<PrivacyState>,
    Extension(actor): Extension<Principal>,
    Path(id): Path<Uuid>,
    Json(body): Json<DecideBody>,
) -> Result<Json<Value>, ApiError> {
    let input = DecideInput {
        kind: body.kind,
        outcome: body.outcome,
        reason: body.reason,
        note: body.note,
        decided_on: body.decided_on,
    };
    let hash = rights::decide_hash(state.store.pool(), &input)
        .await
        .map_err(unavailable)?;
    verify_decide_step_up(&state, &actor, id, hash, body.step_up).await?;

    let mut tx = rights::begin(state.store.pool(), actor.org_id)
        .await
        .map_err(unavailable)?;
    let row = authorize_decision_in_tx(&mut tx, &actor, id, input.kind).await?;
    let updated = rights::apply_decide(&mut tx, actor.org_id, actor.user_id, id, &row.body, &input)
        .await
        .map_err(store_error)?;
    tx.commit().await.map_err(unavailable)?;
    Ok(Json(updated))
}

pub(super) async fn postpone(
    State(state): State<PrivacyState>,
    Extension(actor): Extension<Principal>,
    Path(id): Path<Uuid>,
    Json(body): Json<PostponeBody>,
) -> Result<Json<Value>, ApiError> {
    let input = PostponeInput {
        kind: body.kind,
        reason: body.reason,
        note: body.note,
        decided_on: body.decided_on,
    };
    let hash = rights::postpone_hash(state.store.pool(), &input)
        .await
        .map_err(unavailable)?;
    verify_decide_step_up(&state, &actor, id, hash, body.step_up).await?;

    let mut tx = rights::begin(state.store.pool(), actor.org_id)
        .await
        .map_err(unavailable)?;
    let row = authorize_decision_in_tx(&mut tx, &actor, id, input.kind).await?;
    let updated =
        rights::apply_postpone(&mut tx, actor.org_id, actor.user_id, id, &row.body, &input)
            .await
            .map_err(store_error)?;
    tx.commit().await.map_err(unavailable)?;
    Ok(Json(updated))
}

pub(super) async fn objection(
    State(state): State<PrivacyState>,
    Extension(actor): Extension<Principal>,
    Path(id): Path<Uuid>,
    Json(input): Json<ObjectionInput>,
) -> Result<Json<Value>, ApiError> {
    let mut tx = rights::begin(state.store.pool(), actor.org_id)
        .await
        .map_err(unavailable)?;
    let facts = load_facts(&mut tx, actor.org_id, *actor.user_id.as_uuid())
        .await
        .map_err(unavailable)?;
    #[derive(sqlx::FromRow)]
    struct OriginalRow {
        body: Value,
        subject_user_id: Uuid,
        subject_employee_id: Option<Uuid>,
        org_unit_id: Option<Uuid>,
        workplace_id: Option<Uuid>,
        legal_entity_id: Option<Uuid>,
    }
    let row = sqlx::query_as::<_, OriginalRow>(concat!(
        "SELECT r.body, r.subject_user_id, r.subject_employee_id, e.org_unit_id, ea.workplace_id, ea.legal_entity_id ",
        "FROM privacy_rights_requests r ",
        "LEFT JOIN employees e ON e.org_id=r.org_id AND e.id=r.subject_employee_id ",
        console_hr_adapter_postgres::assignment_lateral!(),
        "WHERE r.org_id=$1 AND r.id=$2"
    ))
    .bind(actor.org_id.as_uuid())
    .bind(id)
    .fetch_optional(tx.as_mut())
    .await
    .map_err(unavailable)?
    .ok_or_else(missing)?;

    let actor_uuid = *actor.user_id.as_uuid();
    let filed_by = if actor_uuid == row.subject_user_id {
        if !facts
            .authorize_privacy_request_read(actor_uuid)
            .map_err(unavailable)?
        {
            return Err(forbidden("forbidden", "privacy objection read refused"));
        }
        None
    } else {
        let controller = row
            .body
            .pointer("/receipt/controller")
            .and_then(Value::as_str);
        if controller != Some("TENANT") {
            return Err(missing());
        }
        let node = EmployeePlacement {
            org_unit_id: row.org_unit_id,
            workplace_id: row.workplace_id,
            legal_entity_id: row.legal_entity_id,
        }
        .node(actor.org_id, &facts);
        if !facts
            .authorize(Feature::PrivacyRequestDecide.as_str(), node)
            .map_err(unavailable)?
        {
            return Err(missing());
        }
        Some(actor_uuid)
    };

    let created = rights::file_objection(
        &mut tx,
        actor.org_id,
        actor.user_id,
        row.subject_user_id,
        row.subject_employee_id,
        filed_by,
        &row.body,
        &input,
    )
    .await
    .map_err(store_error)?;
    tx.commit().await.map_err(unavailable)?;
    Ok(Json(created))
}
