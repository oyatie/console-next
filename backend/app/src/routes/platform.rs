//! The platform tier, the auth routes, the request timeout and realtime: the
//! layer-ordered tail of `build_router`'s tenant arm.

use std::sync::Arc;

use axum::Router;
#[cfg(any(debug_assertions, feature = "e2e-test-support"))]
use console_platform_email::StubEmailMode;
use console_platform_provisioning::PlatformProvisioner;
use console_platform_realtime::sse::{SseConfig, SseState};
use console_platform_realtime::{PgRealtimeHub, RealtimeRestState};
use console_platform_rest::PlatformRestState;

use super::TenantDeps;
use crate::http::overload;
use crate::state::DatabaseDependency;
use crate::wiring::tenant_config::tenant_config_seeder;

/// `router` is the base router, `domain_router` every tenant domain router.
pub(super) fn compose(router: Router, domain_router: Router, deps: &TenantDeps<'_>) -> Router {
    let (state, pool) = (deps.state, deps.pool);
    // Test terms are available only to dev and the explicit E2E support binary.
    #[cfg(any(debug_assertions, feature = "e2e-test-support"))]
    let router = if state.config.email_stub_mode == Some(StubEmailMode::E2e) {
        match &state.e2e_fixture_database {
            DatabaseDependency::Postgres(fixture_pool) => {
                router.merge(super::e2e_fixtures::router(fixture_pool.clone()))
            }
            DatabaseDependency::NotConfigured => router,
        }
    } else {
        router
    };
    let domain_router = domain_router.merge(crate::requests::router(
        pool.clone(),
        state.jwt_verifier.clone(),
    ));
    let realtime_hub = state
        .realtime_hub
        .clone()
        .unwrap_or_else(|| Arc::new(PgRealtimeHub::new(pool.clone(), Default::default())));
    let platform_tenant_config_seeder = match &state.ontology_command_database {
        DatabaseDependency::Postgres(_) => {
            Some(tenant_config_seeder(deps.ontology_registry_store.clone()))
        }
        DatabaseDependency::NotConfigured => None,
    };
    // READ-ONLY WALL for PLATFORM "view as": wrap the WHOLE tenant
    // domain router so any request carrying a `view_as` token may use
    // ONLY GET/HEAD — every other method is rejected 403 `view_as_read_only`
    // BEFORE any handler or per-handler authz runs. This is a blanket
    // method gate keyed purely on the token's `view_as` claim, so no
    // mutation handler on any tenant route is reachable while
    // impersonating, regardless of the acting role. It is orthogonal to
    // (and does not replace) the tenant org middleware each domain router
    // already applies; an ordinary tenant/platform token is untouched.
    let domain_router = console_platform_rest::with_view_as_read_only_gate(
        domain_router,
        state.jwt_verifier.clone(),
    );
    // The realtime WS upgrade and the pre-auth login/refresh endpoints are
    // intentionally NOT under the org middleware: a login request has no
    // tenant yet, and the WS handler runs its own auth over the socket
    // lifetime (a task-local would not survive the upgrade anyway).
    // PLATFORM tier (`/api/platform/*`). Mounted at the APP level (merged,
    // not nested) behind the PLATFORM extractor â deliberately NOT under
    // the tenant org middleware: the PLATFORM extractor rejects a tenant
    // token here (403), and the per-router tenant org middleware rejects a
    // platform token on the tenant `/api/v1/*` routes (403). There is NO
    // blanket `/api/*` platform-token rejection, so `/api/platform/*` is
    // reached untouched by tenant middleware. Living under `/api` lets the
    // ingress `/api`→backend rule route it while the SPA keeps the bare
    // browser routes `/platform/*`. This is the only path that creates org
    // rows.
    let platform_router = console_platform_rest::router(
        PlatformRestState::new(
            pool.clone(),
            state.jwt_verifier.clone(),
            PlatformProvisioner::new(state.config.coldstart_otp_ttl),
        )
        .with_view_as_issuer(state.view_as_issuer.clone())
        .with_passkey_step_up(state.policy_step_up.clone())
        .with_force_remove_command_pool(match &state.platform_force_command_database {
            DatabaseDependency::Postgres(pool) => Some(pool.clone()),
            DatabaseDependency::NotConfigured => None,
        })
        .with_tenant_config_seeder(platform_tenant_config_seeder)
        .with_ops_notices({
            // Renewal notices for the juso keys (D-14, expired, rejected): vendor ops only.
            let juso = state.juso.clone();
            std::sync::Arc::new(move || {
                juso.key_notices()
                    .into_iter()
                    .filter_map(|n| serde_json::to_value(n).ok())
                    .collect()
            })
        }),
    );
    // Everything EXCEPT the realtime WS upgrade: base health/openapi
    // routes, the tenant domain routers, the platform tier, and the
    // pre-auth login/refresh endpoints. These are all short-lived
    // request/response cycles, so they carry the 30s request timeout.
    let timed = {
        let shed = domain_router.merge(platform_router);
        let shed = match state.auth_rest.clone() {
            Some(auth_rest) => {
                // The auth-rest router carries authenticated tenant
                // mutations (issue-OTP, credential-reset, enroll-handoff,
                // passkey register/finish). They live OUTSIDE the tenant
                // domain router, so the view-as read-only wall must also
                // wrap them — otherwise an impersonation token could reach
                // a write here. The pre-auth POSTs (login/refresh/redeem)
                // carry no view_as token, so the gate is a no-op for them.
                let auth_router = console_platform_rest::with_view_as_read_only_gate(
                    console_platform_auth_rest::router(auth_rest),
                    state.jwt_verifier.clone(),
                );
                shed.merge(auth_router)
            }
            None => shed,
        };
        // Load shedding (R3) covers the DB-bound routes only: the base
        // health/openapi routes are merged outside it, so `/readyz` keeps
        // answering while the API sheds.
        let shed = overload::with_load_shed(shed, overload::MAX_IN_FLIGHT);
        // Defense-in-depth: a request that hangs on a slow upstream or DB is
        // answered 503 + Retry-After so a stuck handler cannot pin a worker.
        // Applied BEFORE the realtime router is merged so the long-lived WS
        // connection below is never severed by this 30s budget — this is
        // the #1 regression to prevent (live wallboard/dispatch SSE/WS).
        overload::with_timeout(router.merge(shed), state.config.request_timeout)
    };
    // The realtime WS upgrade and the SSE event stream (decisions #27) are
    // merged AFTER the timeout layer so they escape the 30s budget. They are
    // intentionally NOT under the org middleware: each handler resolves its
    // own bearer and holds the principal for the connection's lifetime.
    let realtime = RealtimeRestState::new(realtime_hub, state.jwt_verifier.clone());
    timed
        .merge(console_platform_realtime::router(realtime.clone()))
        .merge(console_platform_realtime::sse::router(SseState::new(
            realtime,
            SseConfig::default(),
        )))
}
