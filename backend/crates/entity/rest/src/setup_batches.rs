//! Bulk 법인 · 사업장 create and update from a sheet (MR-29): dry run, apply,
//! the receipt list and the SETUP undo.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use console_entity_application::{EntitySetupBatch, Target};
use serde_json::json;
use uuid::Uuid;

use crate::EntityRestState;
use crate::auth::{Need, actor, manager_of};
use crate::error::RestError;
use crate::org_setup::port;

type Result<T> = std::result::Result<T, RestError>;

/// The subjects a batch writes: each revised record, the 법인 a new 사업장
/// joins, and the tenant for a new 법인.
fn targets(b: &EntitySetupBatch) -> Vec<Target> {
    b.ops
        .iter()
        .map(|op| match (op.op.as_deref(), op.id, op.legal_entity_id) {
            (Some("REVISE_ENTITY"), Some(id), _) => Target::Entity(id),
            (Some("REVISE_WORKPLACE"), Some(id), _) => Target::Workplace(id),
            (Some("CREATE_WORKPLACE"), _, Some(entity)) => Target::Entity(entity),
            _ => Target::Tenant,
        })
        .collect()
}

pub(crate) async fn run(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Json(b): Json<EntitySetupBatch>,
) -> Result<Response> {
    let a = manager_of(&s, &h, &targets(&b), !b.dry_run).await?;
    Ok(Json(s.store.entity_setup_batch(&a, b, port(&s)?).await?).into_response())
}

pub(crate) async fn list(State(s): State<EntityRestState>, h: HeaderMap) -> Result<Response> {
    let (a, _) = actor(&s, &h, Need::Read, Target::Tenant).await?;
    Ok(Json(json!({ "items": s.store.list_entity_setup_batches(&a).await? })).into_response())
}

pub(crate) async fn undo(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let (reader, _) = actor(&s, &h, Need::Read, Target::Tenant).await?;
    let targets: Vec<Target> = s
        .store
        .entity_setup_batch_targets(&reader, id)
        .await?
        .into_iter()
        .map(|(kind, id)| match kind.as_str() {
            "workplace" => Target::Workplace(id),
            _ => Target::Entity(id),
        })
        .collect();
    let a = manager_of(&s, &h, &targets, true).await?;
    Ok(Json(s.store.undo_entity_setup_batch(&a, id, port(&s)?).await?).into_response())
}
