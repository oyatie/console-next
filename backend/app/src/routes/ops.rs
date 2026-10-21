//! Ops and audit: health, readiness, OpenAPI, well-known association documents,
//! the app-level audit routes and console telemetry.

use axum::Router;
use axum::routing::get;
use console_platform_auth::{WELL_KNOWN_AASA_PATH, WELL_KNOWN_ASSETLINKS_PATH};

use super::TenantDeps;
use crate::audit_api::{
    AUDIT_ATTESTATION_ROUTE_PATH, AUDIT_ROUTE_PATH, audit_attestation, audit_log,
};
use crate::console_telemetry;
use crate::http::client_errors;
use crate::http::ops::{
    android_assetlinks, apple_app_site_association, healthz, openapi_yaml, readyz,
};
use crate::http::release_toggles::release_toggles;
use crate::state::AppState;

pub(super) fn base_router(state: &AppState) -> Router {
    Router::new()
        // Public aggregate evidence only; tenant SSE retains its authentication and Cedar filters.
        .route(
            crate::http::status::STATUS_ROUTE_PATHS[0],
            get(crate::http::status::evidence),
        )
        .route(
            crate::http::status::STATUS_ROUTE_PATHS[1],
            get(crate::http::status::events),
        )
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/openapi/openapi.yaml", get(openapi_yaml))
        // Public, unauthenticated native app-link association documents. Native
        // passkeys are inert until the platform serves these at the EXACT
        // dotted paths over the RP origin, so they live on the base router with
        // no auth and no tenant middleware (they carry no tenant data).
        .route(WELL_KNOWN_AASA_PATH, get(apple_app_site_association))
        .route(WELL_KNOWN_ASSETLINKS_PATH, get(android_assetlinks))
        // B-01: unauthenticated and DB-free, so it answers while the API sheds.
        .route(
            "/api/v1/client-errors",
            client_errors::post(state.config.web_dist.as_deref()),
        )
        // B-15: deployment config, read by the SPA at boot.
        .route("/api/v1/release-toggles", get(release_toggles))
        .with_state(state.clone())
}

pub(super) fn mount(deps: &TenantDeps<'_>) -> Router {
    let (state, pool) = (deps.state, deps.pool);
    // `/api/audit` is an app-level route, so it gets the same org middleware
    // applied directly here. L20 audit-chain PR-2: the read-only attestation
    // endpoint joins the SAME router (no new `.merge()`), the established
    // pattern for app-level audit REST.
    let audit_router = console_platform_request_context::with_request_context(
        Router::new()
            .route(AUDIT_ROUTE_PATH, get(audit_log))
            .route(AUDIT_ATTESTATION_ROUTE_PATH, get(audit_attestation))
            .with_state(state.clone()),
        state.jwt_verifier.clone(),
        pool.clone(),
    );
    audit_router.merge(console_telemetry::router(
        console_telemetry::ConsoleTelemetryState::new(pool.clone(), state.jwt_verifier.clone()),
    ))
}
