//! Dated history of each record, and the 4대보험 change of a 사업장.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use console_entity_application::{InsuranceRevision, Target};
use serde_json::json;
use uuid::Uuid;

use crate::EntityRestState;
use crate::auth::{Need, manager, read_gate};
use crate::error::RestError;

type Result<T> = std::result::Result<T, RestError>;

pub(crate) async fn entity_history(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    history(&s, &h, id, Target::Entity(id), "legal_entity.history_read").await
}

pub(crate) async fn registration_history(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    history(
        &s,
        &h,
        id,
        Target::Registration(id),
        "business_registration.history_read",
    )
    .await
}

async fn history(
    s: &EntityRestState,
    h: &HeaderMap,
    id: Uuid,
    target: Target,
    action: &'static str,
) -> Result<Response> {
    let result: Result<_> = async {
        let (a, personal, gate) = read_gate(s, h, Need::Read, target).await?;
        let items = match target {
            Target::Entity(_) => s.store.entity_history(&a, id, personal).await?,
            Target::Workplace(_) => s.store.workplace_history(&a, id, personal).await?,
            _ => s.store.registration_history(&a, id, personal).await?,
        };
        Ok((items, gate))
    }
    .await;
    let (items, gate) = match result {
        Ok(value) => value,
        Err(error) => return Err(crate::access_log::refused(s, h, action, id, error).await),
    };
    let mut subjects: Vec<_> = items
        .iter()
        .flat_map(|item| item.subject_refs.iter().cloned())
        .collect();
    subjects.sort_unstable();
    subjects.dedup();
    crate::access_log::record(
        s,
        crate::access_log::event(&gate.principal, action, id.to_string(), &subjects)?,
    )
    .await?;
    Ok(Json(json!({ "items": items })).into_response())
}

pub(crate) async fn workplace_history(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    history(&s, &h, id, Target::Workplace(id), "workplace.history_read").await
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
