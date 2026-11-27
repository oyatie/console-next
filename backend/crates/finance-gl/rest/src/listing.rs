// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[derive(Debug, Deserialize)]
pub(super) struct ListVouchersQuery {
    after: Option<uuid::Uuid>,
    branch_id: Option<BranchId>,
    status: Option<VoucherStatus>,
}

#[derive(Debug, Deserialize)]
pub(super) struct AccountPageQuery {
    after: Option<uuid::Uuid>,
}

fn page_response<T: Serialize>(items: Vec<T>, next: Option<uuid::Uuid>) -> impl IntoResponse {
    let mut headers = HeaderMap::new();
    if let Some(id) = next
        && let Ok(value) = id.to_string().parse()
    {
        headers.insert("x-next-cursor", value);
    }
    (headers, Json(items))
}

pub(super) async fn list_vouchers(
    State(state): State<FinanceGlRestState>,
    headers: HeaderMap,
    Query(query): Query<ListVouchersQuery>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    // A branch-scoped listing authorizes against that branch; an org-wide listing
    // requires org-wide authority (RLS still confines rows to the tenant).
    match query.branch_id {
        Some(branch_id) => authorize(&principal, Action::new(VOUCHER_FEATURE), branch_id)
            .map_err(RestError::from_kernel)?,
        None => authorize_org_wide(&principal, Action::new(VOUCHER_FEATURE))
            .map_err(RestError::from_kernel)?,
    }
    let (vouchers, next) = state
        .store
        .list_page(query.branch_id, query.status, query.after)
        .await
        .map_err(RestError::from_store)?;
    Ok(page_response(vouchers, next))
}

pub(super) async fn account_entries(
    State(state): State<FinanceGlRestState>,
    headers: HeaderMap,
    Path(account_code): Path<String>,
    Query(query): Query<AccountPageQuery>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    // Account drill spans branches — org-wide read authority.
    authorize_org_wide(&principal, Action::new(VOUCHER_FEATURE)).map_err(RestError::from_kernel)?;
    let (entries, next) = state
        .store
        .account_page(&account_code, query.after)
        .await
        .map_err(RestError::from_store)?;
    Ok(page_response(entries, next))
}
