//! 사업장 kind list and a 사업장's kind (decisions #18). Reads take the
//! entity read permission; writes take `legal_entity_manage` (the list on the
//! whole tenant, a kind on its 사업장).

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use console_entity_application::{
    CreateWorkplaceKind, SetWorkplaceKind, Target, UpdateWorkplaceKind,
};
use serde_json::json;
use uuid::Uuid;

use crate::EntityRestState;
use crate::auth::{Need, actor, manager};
use crate::error::RestError;

type Result<T> = std::result::Result<T, RestError>;

pub(crate) async fn list_kinds(State(s): State<EntityRestState>, h: HeaderMap) -> Result<Response> {
    let (a, _) = actor(&s, &h, Need::Read, Target::Tenant).await?;
    Ok(Json(json!({ "items": s.store.list_workplace_kinds(&a).await? })).into_response())
}

pub(crate) async fn create_kind(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Json(b): Json<CreateWorkplaceKind>,
) -> Result<Response> {
    let a = manager(&s, &h, Target::Tenant).await?;
    Ok((
        StatusCode::CREATED,
        Json(s.store.create_workplace_kind(&a, b).await?),
    )
        .into_response())
}

pub(crate) async fn update_kind(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(code): Path<String>,
    Json(b): Json<UpdateWorkplaceKind>,
) -> Result<Response> {
    let a = manager(&s, &h, Target::Tenant).await?;
    Ok(Json(s.store.update_workplace_kind(&a, code, b).await?).into_response())
}

pub(crate) async fn set_kind(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<SetWorkplaceKind>,
) -> Result<Response> {
    let a = manager(&s, &h, Target::Workplace(id)).await?;
    Ok(Json(s.store.set_workplace_kind(&a, id, b).await?).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_label_patch_tells_absent_from_null() {
        let absent: UpdateWorkplaceKind = serde_json::from_str(r#"{"active":false}"#).unwrap();
        let null: UpdateWorkplaceKind = serde_json::from_str(r#"{"label":null}"#).unwrap();
        let set: UpdateWorkplaceKind = serde_json::from_str(r#"{"label":"창고"}"#).unwrap();
        assert_eq!((absent.label, absent.active), (None, Some(false)));
        assert_eq!(null.label, Some(None));
        assert_eq!(set.label, Some(Some("창고".into())));
    }
}
