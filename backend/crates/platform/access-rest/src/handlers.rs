//! Thin HTTP handlers: extract, call the use case, map the refusal.

use axum::Json;
use axum::extract::{Extension, Path, Query, State};
use axum::http::StatusCode;
use console_platform_access::{GrantOut, RoleOut, effective, grants, notice, requests, roles};
use console_platform_authz::Principal;
use serde_json::Value;
use uuid::Uuid;

use crate::AccessRestState;
use crate::error::ApiResult;

type P = Extension<Principal>;
type S = State<AccessRestState>;

pub(crate) async fn list_roles(
    State(s): S,
    Extension(p): P,
    Query(q): Query<roles::StatusFilter>,
) -> ApiResult<Json<Vec<RoleOut>>> {
    Ok(Json(roles::list(&s.service, p, q).await?))
}

pub(crate) async fn get_role(
    State(s): S,
    Extension(p): P,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<RoleOut>> {
    Ok(Json(roles::get_one(&s.service, p, id).await?))
}

pub(crate) async fn role_versions(
    State(s): S,
    Extension(p): P,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Vec<Value>>> {
    Ok(Json(roles::versions(&s.service, p, id).await?))
}

pub(crate) async fn create_role(
    State(s): S,
    Extension(p): P,
    Json(body): Json<roles::CreateRole>,
) -> ApiResult<(StatusCode, Json<RoleOut>)> {
    Ok((
        StatusCode::CREATED,
        Json(roles::create(&s.service, p, body).await?),
    ))
}

pub(crate) async fn update_role(
    State(s): S,
    Extension(p): P,
    Path(id): Path<Uuid>,
    Json(body): Json<roles::UpdateRole>,
) -> ApiResult<Json<RoleOut>> {
    Ok(Json(roles::update(&s.service, p, id, body).await?))
}

pub(crate) async fn set_role_status(
    State(s): S,
    Extension(p): P,
    Path(id): Path<Uuid>,
    Json(body): Json<roles::SetStatus>,
) -> ApiResult<Json<RoleOut>> {
    Ok(Json(roles::set_status(&s.service, p, id, body).await?))
}

pub(crate) async fn delete_role(
    State(s): S,
    Extension(p): P,
    Path(id): Path<Uuid>,
    Query(q): Query<roles::ExpectedVersion>,
) -> ApiResult<StatusCode> {
    roles::delete(&s.service, p, id, q).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn list_grants(
    State(s): S,
    Extension(p): P,
    Query(q): Query<grants::GrantQuery>,
) -> ApiResult<Json<Vec<GrantOut>>> {
    Ok(Json(grants::list(&s.service, p, q).await?))
}

pub(crate) async fn preview_grants(
    State(s): S,
    Extension(p): P,
    Json(body): Json<grants::Batch>,
) -> ApiResult<Json<Value>> {
    Ok(Json(grants::preview(&s.service, p, body).await?))
}

pub(crate) async fn apply_grants(
    State(s): S,
    Extension(p): P,
    Json(body): Json<grants::Apply>,
) -> ApiResult<Json<grants::ApplyOutcome>> {
    Ok(Json(grants::apply(&s.service, p, body).await?))
}

pub(crate) async fn account_effective(
    State(s): S,
    Extension(p): P,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    Ok(Json(effective::account(&s.service, p, id).await?))
}

pub(crate) async fn confirm_grant_notice(
    State(s): S,
    Extension(p): P,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    Ok(Json(notice::confirm(&s.service, p, id).await?))
}

pub(crate) async fn my_effective(State(s): S, Extension(p): P) -> ApiResult<Json<Value>> {
    Ok(Json(effective::me(&s.service, p).await?))
}

pub(crate) async fn ops_account(State(s): S, Extension(p): P) -> ApiResult<Json<Value>> {
    Ok(Json(effective::ops(&s.service, p).await?))
}

pub(crate) async fn ops_usage(
    State(s): S,
    Extension(p): P,
    Query(q): Query<effective::UsageQuery>,
) -> ApiResult<Json<Vec<Value>>> {
    Ok(Json(effective::ops_usage(&s.service, p, q).await?))
}

pub(crate) async fn create_request(
    State(s): S,
    Extension(p): P,
    Json(body): Json<requests::NewRequest>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let (created, request) = requests::create(&s.service, p, body).await?;
    let status = if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(request)))
}

pub(crate) async fn list_requests(State(s): S, Extension(p): P) -> ApiResult<Json<Vec<Value>>> {
    Ok(Json(requests::list(&s.service, p).await?))
}

pub(crate) async fn close_request(
    State(s): S,
    Extension(p): P,
    Path(id): Path<Uuid>,
    Json(body): Json<requests::Close>,
) -> ApiResult<Json<Value>> {
    Ok(Json(requests::close(&s.service, p, id, body).await?))
}

pub(crate) async fn granters(State(s): S, Extension(p): P) -> ApiResult<Json<Value>> {
    Ok(Json(requests::granters(&s.service, p).await?))
}
