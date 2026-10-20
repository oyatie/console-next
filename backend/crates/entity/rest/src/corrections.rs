//! Identifier corrections (MR-17), 사업장 registration-link changes (MR-18)
//! and 등록증 재발급·정정.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use console_entity_adapter_postgres::CorrectionOutcome;
use console_entity_application::{RegistrationReissue, Target};
use console_entity_domain::correction::{IdentifierCorrectionInput, RegistrationChangeInput};
use uuid::Uuid;

use crate::EntityRestState;
use crate::auth::{manager, manager_or_ops};
use crate::error::RestError;

type Result<T> = std::result::Result<T, RestError>;

pub(crate) async fn correct_entity(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(mut b): Json<IdentifierCorrectionInput>,
) -> Result<Response> {
    let (a, by_ops) = manager_or_ops(&s, &h, Target::Entity(id)).await?;
    b.by_ops = by_ops;
    let saved = s
        .store
        .correct_entity_identifier(&a, id, b, s.governed.clone())
        .await?;
    Ok(correction_response(saved))
}

pub(crate) async fn correct_registration(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(mut b): Json<IdentifierCorrectionInput>,
) -> Result<Response> {
    let (a, by_ops) = manager_or_ops(&s, &h, Target::Registration(id)).await?;
    b.by_ops = by_ops;
    let saved = s
        .store
        .correct_registration_number(&a, id, b, s.governed.clone())
        .await?;
    Ok(correction_response(saved))
}

pub(crate) async fn change_registration(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<RegistrationChangeInput>,
) -> Result<Response> {
    let a = manager(&s, &h, Target::Workplace(id)).await?;
    Ok(Json(s.store.change_workplace_registration(&a, id, b).await?).into_response())
}

/// 등록증 재발급·정정: the new certificate and the facts it changed, one change.
pub(crate) async fn reissue(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<RegistrationReissue>,
) -> Result<Response> {
    let a = manager(&s, &h, Target::Registration(id)).await?;
    Ok(Json(s.store.reissue_registration(&a, id, b).await?).into_response())
}

fn correction_response<T: serde::Serialize>(outcome: CorrectionOutcome<T>) -> Response {
    match outcome {
        CorrectionOutcome::Applied(saved) => Json(saved).into_response(),
        CorrectionOutcome::Pending { exception_id, payload_hash } => (StatusCode::ACCEPTED, Json(serde_json::json!({ "status": "PENDING", "exception_id": exception_id, "payload_hash": payload_hash }))).into_response(),
    }
}
