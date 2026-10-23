// SPDX-License-Identifier: LicenseRef-Proprietary
//! HR-only read side for unresolved system Person binding evidence.

use axum::{
    Extension, Json, Router,
    extract::{Query, State},
    routing::get,
};
use console_hr_adapter_postgres::{
    HrService,
    person_binding::{PersonBindingReviews, ReviewQuery},
};
use console_platform_authz::Principal;

use crate::HrApiError;

pub const REVIEWS_PATH: &str = "/api/v1/person-binding-reviews";

pub fn router(hr: HrService) -> Router {
    Router::new().route(REVIEWS_PATH, get(list)).with_state(hr)
}

async fn list(
    State(hr): State<HrService>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<ReviewQuery>,
) -> Result<Json<PersonBindingReviews>, HrApiError> {
    Ok(Json(hr.person_binding_reviews(principal, query).await?))
}
