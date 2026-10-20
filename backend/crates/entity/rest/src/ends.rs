//! End-options drives deletion, retirement, and closure choices across surfaces.
//! Direct department writes require `org_unit_manage` and disabled org-structure approval after go-live.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use console_entity_application::Target;
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::EntityRestState;
use crate::auth::{record_reader, unit_manager, unit_reader};
use crate::error::RestError;
use crate::org_setup::port;

type Result<T> = std::result::Result<T, RestError>;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Pinned {
    expected_version: i32,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Details {
    expected_version: i32,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    head_employee_id: Option<Uuid>,
}

pub(crate) async fn unit_end_options(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let (a, can) = unit_reader(&s, &h).await?;
    let options = s.store.org_unit_end_options(&a, id, port(&s)?).await?;
    let mut body = json!(options);
    body["can_manage"] = json!(can);
    Ok(Json(body).into_response())
}

pub(crate) async fn erase_unit(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<Pinned>,
) -> Result<Response> {
    let a = unit_manager(&s, &h).await?;
    Ok(Json(s.store.erase_org_unit(&a, id, b.expected_version).await?).into_response())
}

pub(crate) async fn dissolve_unit(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<Pinned>,
) -> Result<Response> {
    let a = unit_manager(&s, &h).await?;
    let r = s
        .store
        .dissolve_org_unit(&a, id, b.expected_version, port(&s)?)
        .await?;
    Ok((StatusCode::OK, Json(r)).into_response())
}

pub(crate) async fn set_unit_details(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<Details>,
) -> Result<Response> {
    let a = unit_manager(&s, &h).await?;
    let r = s
        .store
        .set_org_unit_details(
            &a,
            id,
            b.expected_version,
            b.code,
            b.head_employee_id,
            port(&s)?,
        )
        .await?;
    Ok((StatusCode::OK, Json(r)).into_response())
}

async fn record(
    s: &EntityRestState,
    h: &HeaderMap,
    target: Target,
    column: &'static str,
    id: Uuid,
) -> Result<Response> {
    let (a, can) = record_reader(s, h, target).await?;
    let options = s.store.record_end_options(&a, column, id).await?;
    let mut body = json!(options);
    body["can_manage"] = json!(can);
    Ok(Json(body).into_response())
}

pub(crate) async fn entity_end_options(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    record(&s, &h, Target::Entity(id), "legal_entity_id", id).await
}

pub(crate) async fn workplace_end_options(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    record(&s, &h, Target::Workplace(id), "workplace_id", id).await
}

pub(crate) async fn registration_end_options(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let (a, can) = record_reader(&s, &h, Target::Registration(id)).await?;
    let mut body = json!(s.store.registration_end_options(&a, id).await?);
    body["can_manage"] = json!(can);
    Ok(Json(body).into_response())
}
