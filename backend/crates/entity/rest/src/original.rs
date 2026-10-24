// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::{EntityRestState, auth::manager, error::RestError};
use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use console_entity_application::{EntityDocumentView, Target};
use serde::Deserialize;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Original {
    document_id: Uuid,
}

pub(crate) async fn attach(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Original>,
) -> Result<Json<EntityDocumentView>, RestError> {
    let actor = manager(&s, &h, Target::Registration(id)).await?;
    Ok(Json(
        s.store
            .attach_registration_original(&actor, id, body.document_id)
            .await?,
    ))
}
