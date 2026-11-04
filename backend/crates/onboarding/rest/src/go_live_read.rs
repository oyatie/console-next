// SPDX-License-Identifier: LicenseRef-Proprietary
//! Read handlers for the current preview and immutable go-live receipt.
use super::*;

pub(super) async fn preview(
    State(s): State<OnboardingRestState>,
    h: HeaderMap,
) -> Result<Response, RestError> {
    let a = actor(&s, &h).await?;
    Ok(Json(s.store.preview(&a).await?).into_response())
}

pub(super) async fn receipt(
    State(s): State<OnboardingRestState>,
    h: HeaderMap,
) -> Result<Response, RestError> {
    let a = actor(&s, &h).await?;
    Ok(Json(s.store.receipt(&a).await?).into_response())
}
