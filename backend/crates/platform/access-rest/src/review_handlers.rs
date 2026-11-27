// SPDX-License-Identifier: LicenseRef-Proprietary
//! HTTP handlers for periodic access reviews (`/api/v1/access/reviews*`).

use axum::Json;
use axum::extract::{Extension, Path, Query, State};
use axum::http::{HeaderMap, header};
use axum::response::IntoResponse;
use console_platform_access::access_review::{
    self, AccessReviewDecisionInput, AccessReviewDetail, AccessReviewSummary, CompleteReviewInput,
    ExportQuery,
};
use console_platform_authz::Principal;

use crate::AccessRestState;
use crate::error::ApiResult;

type P = Extension<Principal>;
type S = State<AccessRestState>;

fn idempotency_key(headers: &HeaderMap) -> String {
    headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_owned()
}

pub(crate) async fn list_access_reviews(
    State(s): S,
    Extension(p): P,
) -> ApiResult<Json<Vec<AccessReviewSummary>>> {
    Ok(Json(access_review::list(&s.service, p).await?))
}

pub(crate) async fn get_access_review(
    State(s): S,
    Extension(p): P,
    Path(period): Path<String>,
) -> ApiResult<Json<AccessReviewDetail>> {
    Ok(Json(access_review::get(&s.service, p, period).await?))
}

pub(crate) async fn start_access_review(
    State(s): S,
    Extension(p): P,
    Path(period): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Json<AccessReviewDetail>> {
    Ok(Json(
        access_review::start(&s.service, p, period, idempotency_key(&headers)).await?,
    ))
}

pub(crate) async fn record_access_review_decision(
    State(s): S,
    Extension(p): P,
    Path(period): Path<String>,
    headers: HeaderMap,
    Json(body): Json<AccessReviewDecisionInput>,
) -> ApiResult<Json<AccessReviewDetail>> {
    Ok(Json(
        access_review::decide(&s.service, p, period, idempotency_key(&headers), body).await?,
    ))
}

pub(crate) async fn complete_access_review(
    State(s): S,
    Extension(p): P,
    Path(period): Path<String>,
    headers: HeaderMap,
    body: Option<Json<CompleteReviewInput>>,
) -> ApiResult<Json<AccessReviewDetail>> {
    let step_up = body.and_then(|b| b.0.step_up);
    Ok(Json(
        access_review::complete(&s.service, p, period, idempotency_key(&headers), step_up).await?,
    ))
}

pub(crate) async fn export_access_review_csv(
    State(s): S,
    Extension(p): P,
    Path(period): Path<String>,
    Query(q): Query<ExportQuery>,
) -> ApiResult<impl IntoResponse> {
    let csv = access_review::export_csv(&s.service, p, period, q).await?;
    Ok(([(header::CONTENT_TYPE, "text/csv; charset=utf-8")], csv))
}
