//! Setup 부서 routes (MR-12): one unit at a time, a batch, its undo and the
//! batch list. All take the org-change apply permission; every write is
//! admitted for SETUP only by the adapter (after go-live: `phase_not_setup`,
//! remedy `submit_org_change`).

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use console_entity_application::{
    CreateSetupOrgUnit, OrgSetupBatch, OrgSetupReceipt, RenameSetupOrgUnit, Target,
};
use console_entity_domain::Refusal;
use console_kernel_core::ErrorKind;
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::EntityRestState;
use crate::auth::{Need, actor, writer};
use crate::error::RestError;

type Result<T> = std::result::Result<T, RestError>;

pub(crate) fn port(
    s: &EntityRestState,
) -> Result<std::sync::Arc<dyn console_entity_adapter_postgres::OrgUnitSetupWritePort>> {
    s.org_units.clone().ok_or_else(|| {
        RestError(Refusal::new(
            ErrorKind::Internal,
            "unavailable",
            "org-unit writes are not wired",
        ))
    })
}

/// One unit's change: the unit, its new version and the batch to undo.
fn unit(status: StatusCode, receipt: &OrgSetupReceipt, id: Uuid) -> Response {
    let version = receipt
        .units
        .iter()
        .rev()
        .find(|u| u.org_unit_id == id)
        .map(|u| u.version);
    let body = json!({ "id": id, "version": version, "batch_id": receipt.batch_id, "change_mode": receipt.change_mode });
    (status, Json(body)).into_response()
}

pub(crate) async fn create_setup_unit(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Json(b): Json<CreateSetupOrgUnit>,
) -> Result<Response> {
    let a = writer(&s, &h, Need::Structure).await?;
    let receipt = s.store.create_setup_org_unit(&a, b, port(&s)?).await?;
    let id = receipt
        .units
        .first()
        .map(|u| u.org_unit_id)
        .ok_or_else(|| Refusal::not_found("org_unit_not_found"))?;
    Ok(unit(StatusCode::CREATED, &receipt, id))
}

pub(crate) async fn rename_setup_unit(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<RenameSetupOrgUnit>,
) -> Result<Response> {
    let a = writer(&s, &h, Need::Structure).await?;
    let receipt = s.store.rename_setup_org_unit(&a, id, b, port(&s)?).await?;
    Ok(unit(StatusCode::OK, &receipt, id))
}

#[derive(Debug, Deserialize)]
pub(crate) struct DissolveQuery {
    expected_version: Option<i32>,
}

pub(crate) async fn dissolve_setup_unit(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Query(q): Query<DissolveQuery>,
) -> Result<Response> {
    let a = writer(&s, &h, Need::Structure).await?;
    let receipt = s
        .store
        .dissolve_setup_org_unit(&a, id, q.expected_version, port(&s)?)
        .await?;
    Ok(unit(StatusCode::OK, &receipt, id))
}

pub(crate) async fn apply_batch(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Json(b): Json<OrgSetupBatch>,
) -> Result<Response> {
    let a = writer(&s, &h, Need::Structure).await?;
    let receipt = s.store.apply_org_setup_batch(&a, b.ops, port(&s)?).await?;
    Ok((StatusCode::CREATED, Json(receipt)).into_response())
}

pub(crate) async fn undo_batch(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let a = writer(&s, &h, Need::Structure).await?;
    let receipt = s.store.undo_org_setup_batch(&a, id, port(&s)?).await?;
    Ok((StatusCode::CREATED, Json(receipt)).into_response())
}

pub(crate) async fn list_batches(
    State(s): State<EntityRestState>,
    h: HeaderMap,
) -> Result<Response> {
    let (a, _) = actor(&s, &h, Need::Read, Target::Tenant).await?;
    Ok(Json(json!({ "items": s.store.list_org_setup_batches(&a).await? })).into_response())
}
