use crate::authz::authorize_org_manage;
use crate::context::principal_from_headers;
use crate::error::RestError;
use crate::state::IdentityRestState;
use axum::Json;
use axum::extract::Path;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use console_kernel_core::KernelError;
use console_platform_authz::Feature;

// ---------------------------------------------------------------------------
// Region handlers
// ---------------------------------------------------------------------------

pub(crate) async fn list_regions(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    // Any authenticated user may read the org tree (needed to populate pickers).
    authorize_org_manage(&principal, Feature::Login)?;
    let regions = state
        .store
        .list_regions()
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(regions))
}

// ---------------------------------------------------------------------------
// Branch handlers
// ---------------------------------------------------------------------------

pub(crate) async fn list_branches(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    // Any authenticated user may read the branch list (org pickers + support
    // triage). Branch-scoped data on the branches themselves is not sensitive.
    authorize_org_manage(&principal, Feature::Login)?;
    let branches = state
        .store
        .list_branches()
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(branches))
}

// Get-one for an org-unit (branch) pin panel (UI-M2a). Same non-sensitive read
// gate as the list; org-RLS scopes it to the caller's org. No audit — this is
// org-structure metadata, not PII. It filters the branch list rather than
// adding a get-one store method because branch counts are small.
pub(crate) async fn get_branch(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Path(id): Path<uuid::Uuid>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage(&principal, Feature::Login)?;
    let branch = state
        .store
        .list_branches()
        .await
        .map_err(RestError::from_store)?
        .into_iter()
        .find(|b| b.id.as_uuid() == &id)
        .ok_or_else(|| RestError::from_kernel(KernelError::not_found("branch was not found")))?;
    Ok(Json(branch))
}
