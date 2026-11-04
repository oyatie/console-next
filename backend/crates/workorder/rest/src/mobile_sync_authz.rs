// SPDX-License-Identifier: LicenseRef-Proprietary

use axum::http::HeaderMap;
use console_platform_authz::{AuthorizationResource, Feature, Principal};
use console_platform_db::with_org_conn;
use console_workorder_adapter_postgres::PgWorkOrderError;

use super::{MobileRestState, RestError, device_hash_from_headers, mobile_principal_from_headers};

pub(super) async fn admit<S>(
    state: &MobileRestState<S>,
    headers: &HeaderMap,
) -> Result<(Principal, String), RestError> {
    let principal = mobile_principal_from_headers(state, headers).await?;
    let live_roles = if principal.support.is_some() {
        Vec::new()
    } else {
        let org = principal.org_id;
        let actor = *principal.user_id.as_uuid();
        with_org_conn(&state.pool, org, move |tx| {
            Box::pin(async move {
                let snapshot =
                    console_platform_authz::cedar_pbac::visible::load_facts(tx, org, actor)
                        .await
                        .map_err(PgWorkOrderError::Domain)?;
                Ok::<_, PgWorkOrderError>(snapshot.roles().to_vec())
            })
        })
        .await
        .map_err(RestError::from_store)?
    };
    let facts = console_platform_authz::cedar_pbac::actions::work_order_start::decision_facts(
        &principal,
        &live_roles,
        time::OffsetDateTime::now_utc(),
    );
    console_platform_authz::cedar_pbac::enforce::enforce_action(
        &principal,
        Feature::WorkOrderStart,
        AuthorizationResource::org_wide(principal.org_id, "mobile_sync"),
        &facts,
    )
    .map_err(RestError::from_kernel)?;
    let device_hash = device_hash_from_headers(headers)?;
    Ok((principal, device_hash))
}
