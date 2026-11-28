use crate::context::principal_from_headers;
use crate::error::RestError;
use crate::me::authz::{ServedModules, served_authz_projection};
use crate::state::IdentityRestState;
use crate::users::dto::UpdateSelfRequest;
use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use console_identity_application::{CurrentUser, UpdateSelfProfileCommand};
use console_kernel_core::TraceContext;
use time::OffsetDateTime;

// ---------------------------------------------------------------------------
// Self-profile handlers (any authenticated user)
// ---------------------------------------------------------------------------

pub(crate) async fn get_me(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    // A user can always read their own record regardless of branch scope.
    let summary = state
        .store
        .get_me_summary(principal.user_id)
        .await
        .map_err(RestError::from_store)?;
    let tenant = state
        .tenant_facts
        .read_tenant(principal.org_id)
        .await
        .map_err(RestError::from_kernel)?;
    Ok(Json(CurrentUser {
        user: summary,
        tenant: Some(tenant),
    }))
}

pub(crate) async fn update_me(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Json(body): Json<UpdateSelfRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let summary = state
        .store
        .update_self_profile(UpdateSelfProfileCommand {
            user_id: principal.user_id,
            display_name: body.display_name,
            phone: body.phone,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(summary))
}

pub(crate) async fn get_me_authz(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    use console_platform_request_context::tenant_module::TenantModule;
    let tasks = (state.evaluation_tasks)(&principal);
    let (read_cycles, create_cycles) = (state.evaluation_cycles)(&principal);
    let (read_benefits, manage_benefits) = (state.benefit_access)(&principal);
    let (read_consulting, manage_consulting) = (state.consulting_access)(&principal);
    let requested = [
        (
            TenantModule::Consulting,
            read_consulting || manage_consulting,
        ),
        (
            TenantModule::Evaluation,
            tasks || read_cycles || create_cycles,
        ),
        (TenantModule::Benefits, read_benefits || manage_benefits),
        (TenantModule::Calendar, (state.calendar_access)(&principal)),
    ]
    .into_iter()
    .filter_map(|(module, allowed)| allowed.then_some(module))
    .collect();
    let enabled = TenantModule::enabled_modules(state.pool(), principal.org_id, requested)
        .await
        .map_err(RestError::from_kernel)?;
    let evaluation = enabled.contains(&TenantModule::Evaluation);
    let benefits = enabled.contains(&TenantModule::Benefits);
    let consulting = enabled.contains(&TenantModule::Consulting);
    let calendar = enabled.contains(&TenantModule::Calendar);
    Ok(Json(served_authz_projection(
        &principal,
        ServedModules {
            documents: state.documents_served,
            analytics_projection: (state.projection_available)(&principal),
            integrity: (state.integrity_access)(&principal),
            ledger: (state.ledger_access)(&principal),
            benefits: (benefits && read_benefits, benefits && manage_benefits),
            consulting: (
                consulting && read_consulting,
                consulting && manage_consulting,
            ),
            calendar,
            evaluation_tasks: evaluation && tasks,
            evaluation_cycles: (evaluation && read_cycles, evaluation && create_cycles),
        },
    )))
}
