//! Handlers: resolve the principal, authorize, call the store, map errors.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use console_entity_application::{
    AsOfQuery, BindAssignment, CloseCorrection, CloseLegalEntity, CloseWithdrawal, CreateWorkplace,
    EntityRoles, LegalEntityRevision, LegalEntityView, MapCompanyText, RegistrationRevision,
    RegistrationStatusInput, SettleNameReview, Target, VoidRecord, WorkplaceRevision,
};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::EntityRestState;
use crate::auth::{Gate, Need, actor, manager, read_gate, writer};
use crate::error::RestError;
use crate::org_setup::port;

type Result<T> = std::result::Result<T, RestError>;

fn created<T: serde::Serialize>(value: T) -> Response {
    (StatusCode::CREATED, Json(value)).into_response()
}

/// Each record's verbs for this reader: the 법인 and each 사업장 it shows.
fn mark(gate: &Gate, e: &mut LegalEntityView) {
    e.can_manage = !e.read.read_only && gate.may(&[e.id]);
    for w in &mut e.workplaces {
        w.can_manage = !w.read.read_only && gate.may(&[e.id, w.id]);
    }
}

pub(crate) async fn list_entities(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Query(q): Query<AsOfQuery>,
) -> Result<Response> {
    let (a, personal, gate) = read_gate(&s, &h, Need::Read, Target::Tenant).await?;
    let mut items = s
        .store
        .list_entities_at(
            &a,
            personal,
            crate::asof::validated(&s, &a, q.parse()).await?,
        )
        .await?;
    items.iter_mut().for_each(|e| mark(&gate, e));
    Ok(Json(json!({ "items": items })).into_response())
}

pub(crate) async fn list_workplaces(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Query(q): Query<AsOfQuery>,
) -> Result<Response> {
    let (a, personal, gate) = read_gate(&s, &h, Need::Read, Target::Tenant).await?;
    let mut entities = s
        .store
        .list_entities_at(
            &a,
            personal,
            crate::asof::validated(&s, &a, q.parse()).await?,
        )
        .await?;
    entities.iter_mut().for_each(|e| mark(&gate, e));
    let items: Vec<_> = entities.into_iter().flat_map(|e| e.workplaces).collect();
    Ok(Json(json!({"items":items})).into_response())
}

pub(crate) async fn get_entity(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Query(q): Query<AsOfQuery>,
) -> Result<Response> {
    let (a, personal, gate) = read_gate(&s, &h, Need::Read, Target::Entity(id)).await?;
    let mut e = s
        .store
        .get_entity_at(
            &a,
            id,
            personal,
            crate::asof::validated(&s, &a, q.parse()).await?,
        )
        .await?;
    mark(&gate, &mut e);
    Ok(Json(e).into_response())
}

pub(crate) async fn revise_entity(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<LegalEntityRevision>,
) -> Result<Response> {
    let a = manager(&s, &h, Target::Entity(id)).await?;
    Ok(Json(s.store.revise_entity(&a, id, b).await?).into_response())
}

pub(crate) async fn set_roles(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<EntityRoles>,
) -> Result<Response> {
    let a = manager(&s, &h, Target::Entity(id)).await?;
    Ok(Json(s.store.set_entity_roles(&a, id, b).await?).into_response())
}

/// Settle a one-time 법인명 review (20261013153646645): keep the name, or take the 상호 by 정정.
pub(crate) async fn settle_name_review(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path((id, review)): Path<(Uuid, Uuid)>,
    Json(b): Json<SettleNameReview>,
) -> Result<Response> {
    let a = manager(&s, &h, Target::Entity(id)).await?;
    Ok(Json(s.store.settle_name_review(&a, id, review, b).await?).into_response())
}

pub(crate) async fn void_entity(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<VoidRecord>,
) -> Result<Response> {
    let a = manager(&s, &h, Target::Entity(id)).await?;
    s.store.void_entity(&a, id, b, port(&s)?).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// MR-15: 해산 or 폐업; its open 사업장 and 사업자등록 close with it.
pub(crate) async fn close_entity(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<CloseLegalEntity>,
) -> Result<Response> {
    let a = manager(&s, &h, Target::Entity(id)).await?;
    Ok(Json(s.store.close_entity(&a, id, b, port(&s)?).await?).into_response())
}

/// catalog company-19: correct a closed 법인's 종료일 / 종료 사유 (never reopens).
pub(crate) async fn correct_close(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<CloseCorrection>,
) -> Result<Response> {
    let a = manager(&s, &h, Target::Entity(id)).await?;
    Ok(Json(s.store.correct_close(&a, id, b).await?).into_response())
}

/// UX-R3 company-15: withdraw a closed 법인's close (종료 취소); what closed with it reopens.
pub(crate) async fn withdraw_close(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<CloseWithdrawal>,
) -> Result<Response> {
    let a = manager(&s, &h, Target::Entity(id)).await?;
    Ok(Json(s.store.withdraw_close(&a, id, b, port(&s)?).await?).into_response())
}

#[derive(Debug, Deserialize)]
pub(crate) struct ReviseRegistrationBody {
    #[serde(flatten)]
    pub(crate) rev: RegistrationRevision,
    #[serde(flatten)]
    pub(crate) status: RegistrationStatusInput,
}

pub(crate) async fn void_registration(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<VoidRecord>,
) -> Result<Response> {
    let a = manager(&s, &h, Target::Registration(id)).await?;
    s.store.void_registration(&a, id, b).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

pub(crate) async fn create_workplace(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<CreateWorkplace>,
) -> Result<Response> {
    let a = manager(&s, &h, Target::Entity(id)).await?;
    Ok(created(
        s.store
            .create_workplace_with_references(&a, id, b, port(&s)?, Some(resolve_workplace_reason))
            .await?,
    ))
}

pub(crate) async fn revise_workplace(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<WorkplaceRevision>,
) -> Result<Response> {
    let a = manager(&s, &h, Target::Workplace(id)).await?;
    Ok(Json(
        s.store
            .revise_workplace_with_references(&a, id, b, port(&s)?, Some(resolve_workplace_reason))
            .await?,
    )
    .into_response())
}

pub(crate) async fn void_workplace(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<VoidRecord>,
) -> Result<Response> {
    let a = manager(&s, &h, Target::Workplace(id)).await?;
    s.store.void_workplace(&a, id, b, port(&s)?).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

pub(crate) async fn org_structure(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Query(q): Query<AsOfQuery>,
) -> Result<Response> {
    let (a, _) = actor(&s, &h, Need::Read, Target::Tenant).await?;
    Ok(Json(
        s.store
            .org_structure_at(&a, crate::asof::validated(&s, &a, q.parse()).await?)
            .await?,
    )
    .into_response())
}

pub(crate) async fn bind_assignment(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Json(b): Json<BindAssignment>,
) -> Result<Response> {
    let a = writer(&s, &h, Need::People).await?;
    Ok(created(s.store.bind_assignment(&a, b).await?))
}

#[derive(Debug, serde::Deserialize)]
pub(crate) struct AssignmentsQuery {
    employee_id: Uuid,
}

pub(crate) async fn list_assignments(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    axum::extract::Query(q): axum::extract::Query<AssignmentsQuery>,
) -> Result<Response> {
    // Two ids and dates, nothing personal: readable by whoever reads the entities.
    let (a, _) = actor(&s, &h, Need::Read, Target::Tenant).await?;
    Ok(
        Json(json!({ "items": s.store.list_assignments(&a, q.employee_id).await? }))
            .into_response(),
    )
}

pub(crate) async fn unmapped_companies(
    State(s): State<EntityRestState>,
    h: HeaderMap,
) -> Result<Response> {
    let (a, _) = actor(&s, &h, Need::People, Target::Tenant).await?;
    Ok(Json(json!({ "items": s.store.unmapped_companies(&a).await? })).into_response())
}

pub(crate) async fn map_company(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Json(b): Json<MapCompanyText>,
) -> Result<Response> {
    let a = writer(&s, &h, Need::People).await?;
    Ok(Json(json!({ "mapped": s.store.map_company_text(&a, b).await? })).into_response())
}

#[path = "workplace_reference.rs"]
mod workplace_reference;
pub(crate) use workplace_reference::resolve_workplace_reason;
