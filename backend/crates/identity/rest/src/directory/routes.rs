use crate::access_log;
use crate::authz::directory_read_scope;
use crate::context::principal_from_headers;
use crate::directory::dto::DirectoryListRequest;
use crate::directory::dto::DirectoryPage;
use crate::directory::dto::VisibleDirectoryPerson;
use crate::error::RestError;
use crate::state::IdentityRestState;
use axum::Json;
use axum::extract::Query;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use console_identity_application::DirectoryListQuery;

pub(crate) async fn list_directory_people(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Query(request): Query<DirectoryListRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let scope = directory_read_scope(&principal)?;
    let page = state
        .store
        .list_directory_people(&scope, request.into_query()?)
        .await
        .map_err(RestError::from_store)?;
    access_log::record_account_page_read(state.pool(), &principal, "directory.list_read", &page)
        .await?;
    Ok(Json(DirectoryPage::from(page)))
}

pub(crate) async fn list_visible_directory_people(
    state: &IdentityRestState,
    headers: &HeaderMap,
) -> Result<Vec<VisibleDirectoryPerson>, RestError> {
    let principal = principal_from_headers(state, headers).await?;
    let scope = directory_read_scope(&principal)?;
    let org = principal.org_id;
    let page = console_platform_request_context::scope_org(org, async {
        state
            .store
            .list_directory_people(
                &scope,
                DirectoryListQuery {
                    search: None,
                    team: None,
                    branch_id: None,
                    roles: Vec::new(),
                    include_inactive: false,
                    limit: Some(100),
                    offset: Some(0),
                },
            )
            .await
    })
    .await
    .map_err(RestError::from_store)?;
    access_log::record_account_page_read(state.pool(), &principal, "directory.list_read", &page)
        .await?;
    Ok(page
        .items
        .into_iter()
        .map(VisibleDirectoryPerson::from)
        .collect())
}
