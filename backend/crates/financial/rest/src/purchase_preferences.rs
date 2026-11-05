// SPDX-License-Identifier: LicenseRef-Proprietary
use console_platform_authz::{AuthorizationResource, Feature, Principal};
use console_platform_db::with_org_conn;

use axum::{Json, extract::State, http::HeaderMap, response::IntoResponse};

use super::{
    FinancialRestState, PgFinancialError, RestError, SavePurchasePreferencesRequest,
    principal_from_headers,
};

pub(super) async fn save_purchase_preferences(
    State(state): State<FinancialRestState>,
    headers: HeaderMap,
    Json(body): Json<SavePurchasePreferencesRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    admit(&state, &principal).await?;
    let preferences = state
        .store
        .save_purchase_feature_preferences(
            principal.user_id,
            "purchase_requests",
            body.schema_version,
            body.preferences,
        )
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(preferences))
}

async fn admit(state: &FinancialRestState, principal: &Principal) -> Result<(), RestError> {
    let live_roles = if principal.support.is_some() {
        Vec::new()
    } else {
        let org = principal.org_id;
        let actor = *principal.user_id.as_uuid();
        with_org_conn(state.store.pool(), org, move |tx| {
            Box::pin(async move {
                let snapshot =
                    console_platform_authz::cedar_pbac::visible::load_facts(tx, org, actor)
                        .await
                        .map_err(PgFinancialError::Domain)?;
                Ok::<_, PgFinancialError>(snapshot.roles().to_vec())
            })
        })
        .await
        .map_err(RestError::from_store)?
    };
    let facts = console_platform_authz::cedar_pbac::actions::purchase_request_read::decision_facts(
        principal,
        &live_roles,
        time::OffsetDateTime::now_utc(),
    );
    console_platform_authz::cedar_pbac::enforce::enforce_action(
        principal,
        Feature::PurchaseRequestRead,
        AuthorizationResource::org_wide(principal.org_id, "purchase_preferences"),
        &facts,
    )
    .map_err(RestError::from_kernel)
}
