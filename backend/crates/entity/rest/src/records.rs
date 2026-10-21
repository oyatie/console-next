//! Dated history of each record, and the 4대보험 change of a 사업장.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use console_entity_application::{InsuranceRevision, Target};
use serde_json::json;
use uuid::Uuid;

use crate::EntityRestState;
use crate::auth::{Need, actor, manager};
use crate::error::RestError;

type Result<T> = std::result::Result<T, RestError>;

pub(crate) async fn entity_history(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let (a, personal) = actor(&s, &h, Need::Read, Target::Entity(id)).await?;
    Ok(Json(json!({ "items": s.store.entity_history(&a, id, personal).await? })).into_response())
}

pub(crate) async fn registration_history(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let (a, personal) = actor(&s, &h, Need::Read, Target::Registration(id)).await?;
    Ok(
        Json(json!({ "items": s.store.registration_history(&a, id, personal).await? }))
            .into_response(),
    )
}

pub(crate) async fn workplace_history(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let (a, personal) = actor(&s, &h, Need::Read, Target::Workplace(id)).await?;
    Ok(
        Json(json!({ "items": s.store.workplace_history(&a, id, personal).await? }))
            .into_response(),
    )
}

pub(crate) async fn revise_insurance(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<InsuranceRevision>,
) -> Result<Response> {
    let a = manager(&s, &h, Target::Workplace(id)).await?;
    Ok(Json(s.store.revise_insurance(&a, id, b).await?).into_response())
}
