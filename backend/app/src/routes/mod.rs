//! HTTP route wiring. `surfaces` lists every configured route surface;
//! `build_router` composes the base routes, one `mount` per bounded context for
//! the tenant domain routers, the platform tier, and the cross-cutting layers.
//!
//! Only the domain `.merge()` calls are grouped by context: axum merges are
//! order-free (overlaps panic either way). Every layer below keeps its place.

#[cfg(any(
    feature = "support",
    feature = "messenger",
    feature = "notifications",
    feature = "inbox",
    feature = "todos",
    feature = "mail",
    feature = "notices"
))]
mod comms;
#[cfg(any(debug_assertions, feature = "e2e-test-support"))]
mod e2e_fixtures;
pub(crate) mod enrollment;
#[cfg(any(
    feature = "dispatch",
    feature = "logistics",
    feature = "inventory",
    feature = "equipment",
    feature = "inspection",
    feature = "registry",
    feature = "workorder",
    feature = "facilities",
    feature = "production"
))]
mod field;
#[cfg(any(
    feature = "financial",
    feature = "sales",
    feature = "reporting",
    feature = "consulting",
    feature = "finance-gl",
    feature = "analytics-quant"
))]
mod finance;
mod identity;
mod ops;
mod org;
mod people;
mod platform;
pub(crate) mod surfaces;
#[cfg(any(feature = "workspace", feature = "office"))]
mod workflow;

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::Request;
use console_inbox_adapter_postgres::PgInboxStore;
use console_leave_adapter_postgres::PgLeaveStore;
#[cfg(any(feature = "messenger", feature = "workorder"))]
use console_messenger_adapter_postgres::PgMessengerStore;
#[cfg(any(
    feature = "messenger",
    feature = "notifications",
    feature = "notices",
    feature = "workorder"
))]
use console_notifications_adapter_postgres::PgNotificationStore;
use console_ontology_adapter_postgres::PgOntologyStore;
#[cfg(any(feature = "messenger", feature = "workorder"))]
use console_platform_realtime::PostgresMessageNotifier;
#[cfg(any(
    feature = "messenger",
    feature = "notifications",
    feature = "notices",
    feature = "workorder"
))]
use console_platform_realtime::PostgresNotificationNotifier;
use sqlx::PgPool;

use crate::error_i18n;
use crate::http::MAX_REQUEST_BODY_BYTES;
use crate::http::cache_control;
use crate::http::metrics::with_metrics;
use crate::http::redact;
use crate::http::trace::http_trace_layer;
use crate::routes::enrollment::with_enrollment_gate;
use crate::spa::serve_spa;
use crate::state::{AppState, DatabaseDependency};

/// What the tenant domain routers share: the state, the runtime pool, and the
/// stores more than one router is built over (one instance each, cloned in).
/// The Postgres stores a single module needs are built in that module's mount
/// (each is a stateless handle over the pool, so a second instance is free).
pub(super) struct TenantDeps<'a> {
    pub(super) state: &'a AppState,
    pub(super) pool: &'a PgPool,
    pub(super) leave_store: PgLeaveStore,
    pub(super) ontology_registry_store: PgOntologyStore,
}

impl<'a> TenantDeps<'a> {
    fn new(state: &'a AppState, pool: &'a PgPool) -> Self {
        // Ontology / governance / policy-studio engine stores (each rest
        // router self-arms `app.current_org`, like every domain router).
        let ontology_registry_store = match &state.ontology_command_database {
            DatabaseDependency::Postgres(command_pool) => {
                PgOntologyStore::new(pool.clone()).with_command_pool(command_pool.clone())
            }
            DatabaseDependency::NotConfigured => PgOntologyStore::new(pool.clone()),
        };
        let leave_store = {
            let store = PgLeaveStore::new(pool.clone(), Arc::new(PgInboxStore::new(pool.clone())));
            match &state.leave_command_database {
                DatabaseDependency::Postgres(command_pool) => {
                    store.with_leave_command_pool(command_pool.clone())
                }
                DatabaseDependency::NotConfigured => store,
            }
        };
        Self {
            state,
            pool,
            leave_store,
            ontology_registry_store,
        }
    }
}

/// The notification-center store with its realtime notifier: the sink the
/// messenger @-mention path and the notice board fan out through (#198).
#[cfg(any(
    feature = "messenger",
    feature = "notifications",
    feature = "notices",
    feature = "workorder"
))]
pub(super) fn notification_store(pool: &PgPool) -> PgNotificationStore {
    PgNotificationStore::new(pool.clone())
        .with_notifier(Arc::new(PostgresNotificationNotifier::new(pool.clone())))
}

/// The messenger store: `@`-mentions create notification-center rows via the
/// #198 sink (fan-out enabled) so a mentioned member sees them in their inbox.
#[cfg(any(feature = "messenger", feature = "workorder"))]
pub(super) fn messenger_store(pool: &PgPool) -> PgMessengerStore {
    PgMessengerStore::new(pool.clone())
        .with_notifier(Arc::new(PostgresMessageNotifier::new(pool.clone())))
        .with_notification_sink(Arc::new(notification_store(pool)))
}

pub fn build_router(state: AppState) -> Router {
    // The base router carries NO cross-cutting layers here. Per axum's `merge`
    // semantics, any layer applied to a router *before* it is merged with the
    // domain routers wraps only the base routes, not the merged-in ones â which
    // is exactly the bug this composition avoids. The trace layer, timeout, and
    // body limit are applied to the FULLY-merged router below so every route
    // (base + domains) is covered, with the realtime route deliberately merged
    // outside the timeout so a long-lived WS connection is never severed.
    let router = ops::base_router(&state);

    let router = match &state.database {
        DatabaseDependency::Postgres(pool) => {
            let deps = TenantDeps::new(&state, pool);
            // Authenticated domain routers (tenant-scoped data). Each domain
            // `router()` self-applies the per-request org middleware (so the
            // behavior is testable per crate), arming `app.current_org` for every
            // route.
            //
            // The MVP surface (Org + HR, decisions #19/#21) mounts first; every
            // other module mounts behind its own Cargo feature (`full` = all).
            // See docs/ops/mvp-build.md.
            let r = ops::mount(&deps);
            let r = identity::mount(r, &deps);
            let r = org::mount(r, &deps);
            let r = people::mount(r, &deps);
            // People modules after the MVP.
            #[cfg(feature = "attendance")]
            let r = people::mount_attendance(r, &deps);
            #[cfg(feature = "leave")]
            let r = people::mount_leave(r, &deps);
            #[cfg(feature = "recruiting")]
            let r = people::mount_recruiting(r, &deps);
            #[cfg(feature = "evaluation")]
            let r = people::mount_evaluation(r, &deps);
            #[cfg(feature = "benefit")]
            let r = people::mount_benefit(r, &deps);
            #[cfg(feature = "payroll")]
            let r = people::mount_payroll(r, &deps);
            // Governance and the ontology engine.
            #[cfg(feature = "compliance")]
            let r = org::mount_compliance(r, &deps);
            #[cfg(feature = "integrity")]
            let r = org::mount_integrity(r, &deps);
            #[cfg(feature = "docs")]
            let r = org::mount_docs(r, &deps);
            #[cfg(feature = "ontology")]
            let r = org::mount_ontology(r, &deps);
            #[cfg(feature = "governance")]
            let r = org::mount_governance(r, &deps);
            // Finance and business.
            #[cfg(feature = "financial")]
            let r = finance::mount_financial(r, &deps);
            #[cfg(feature = "sales")]
            let r = finance::mount_sales(r, &deps);
            #[cfg(feature = "reporting")]
            let r = finance::mount_reporting(r, &deps);
            #[cfg(feature = "consulting")]
            let r = finance::mount_consulting(r, &deps);
            #[cfg(feature = "finance-gl")]
            let r = finance::mount_finance_gl(r, &deps);
            #[cfg(feature = "analytics-quant")]
            let r = finance::mount_analytics_quant(r, &deps);
            // Field operations, maintenance and assets.
            #[cfg(feature = "dispatch")]
            let r = field::mount_dispatch(r, &deps);
            #[cfg(feature = "logistics")]
            let r = field::mount_logistics(r, &deps);
            #[cfg(feature = "inventory")]
            let r = field::mount_inventory(r, &deps);
            #[cfg(feature = "equipment")]
            let r = field::mount_equipment(r, &deps);
            #[cfg(feature = "inspection")]
            let r = field::mount_inspection(r, &deps);
            #[cfg(feature = "registry")]
            let r = field::mount_registry(r, &deps);
            #[cfg(feature = "workorder")]
            let r = field::mount_workorder(r, &deps);
            #[cfg(feature = "facilities")]
            let r = field::mount_facilities(r, &deps);
            #[cfg(feature = "production")]
            let r = field::mount_production(r, &deps);
            // Communication.
            #[cfg(feature = "support")]
            let r = comms::mount_support(r, &deps);
            #[cfg(feature = "messenger")]
            let r = comms::mount_messenger(r, &deps);
            #[cfg(feature = "notifications")]
            let r = comms::mount_notifications(r, &deps);
            #[cfg(feature = "inbox")]
            let r = comms::mount_inbox(r, &deps);
            #[cfg(feature = "todos")]
            let r = comms::mount_todos(r, &deps);
            #[cfg(feature = "mail")]
            let r = comms::mount_mail(r, &deps);
            #[cfg(feature = "notices")]
            let r = comms::mount_notices(r, &deps);
            // Workflow studio and the workspace.
            #[cfg(feature = "workspace")]
            let r = workflow::mount_workspace(r, &deps);
            #[cfg(feature = "office")]
            let r = workflow::mount_office(r, &deps);
            platform::compose(router, r, &deps)
        }
        DatabaseDependency::NotConfigured => router,
    };
    // SPA (CONSOLE_WEB_DIST) as the FALLBACK only: every real route above keeps
    // precedence. HSTS follows CONSOLE_COOKIE_SECURE (default true = HTTPS
    // production); browsers ignore HSTS over plain http anyway.
    let router = match state.config.web_dist.clone() {
        Some(dist) => {
            let hsts = state
                .config
                .auth_rest
                .as_ref()
                .is_none_or(|auth| auth.cookie_secure);
            let dist: Arc<std::path::Path> = dist.into();
            let etag = crate::spa::dist_etag(&dist);
            let csp = crate::spa::spa_csp(state.config.storage.as_ref());
            router.fallback(move |request: Request<Body>| {
                serve_spa(dist.clone(), etag.clone(), hsts, csp.clone(), request)
            })
        }
        None => router,
    };
    // Cross-cutting layers on the FULLY-merged router (base + every domain +
    // platform + realtime + auth), so they actually cover the merged routes:
    //   * DefaultBodyLimit (2 MiB) â bounds every request body. Applied here
    //     (innermost of these), so a per-route `DefaultBodyLimit::max(N)` set
    //     deeper in a domain router (e.g. the 16 MiB equipment import) still
    //     wins. The realtime WS upgrade carries no body, so this is a no-op for
    //     it. Overridable per-route, unlike an outermost RequestBodyLimitLayer.
    //   * TraceLayer â emits a request span for EVERY route, realtime included
    //     (tracing a long-lived WS only logs its start/end, so it is safe).
    let router = with_enrollment_gate(router, state.jwt_verifier.clone());
    let router = router
        .layer(axum::extract::DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
        // A panicking handler answers 500 (logged inside the trace span)
        // instead of dropping the connection.
        .layer(tower_http::catch_panic::CatchPanicLayer::new())
        // R4: no internal error text leaves the process (generic 5xx message
        // + trace_id; text/plain errors → JSON envelope). Inside `localize`,
        // so the generic message is translated by code.
        .layer(axum::middleware::from_fn(redact::redact))
        // Korean `message` for `Accept-Language: ko` (error_i18n's one table).
        .layer(axum::middleware::from_fn(error_i18n::localize))
        // INF-01: `/api` responses get `no-store`; downloads `private, no-store`.
        .layer(axum::middleware::from_fn(cache_control::default_no_store))
        .layer(http_trace_layer());
    // This wraps the fully-composed HTTP surface exactly once.  Every router
    // below consumes the resolved extension; no domain/rate-limit surface is
    // allowed to interpret raw X-Forwarded-For itself.
    let router = console_platform_request_context::with_trusted_client_ip(
        router,
        state.config.trusted_proxy_count,
        state.config.trusted_proxy_cidrs.clone(),
    );
    with_metrics(router, &state)
}

#[cfg(test)]
#[cfg(not(feature = "test-postgres"))]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod router_layer_tests {
    //! Guards the cross-cutting tower-layer composition in `build_router`.
    //!
    //! The bug being prevented: applying `TraceLayer`/`TimeoutLayer`/body-limit
    //! to the *base* router before merging the domain routers leaves the merged
    //! routes with none of them (axum `merge` does not propagate pre-merge
    //! layers). The fix applies trace + body-limit to the fully-merged router
    //! and applies the timeout to base+domains+platform+auth *before* merging
    //! the long-lived realtime route, so the realtime route escapes the timeout.
    //!
    //! These tests assert the *merge-order semantics* the fix relies on, using
    //! the same `with_timeout` and `.merge()` ordering as `build_router`. A
    //! route merged INSIDE the timeout 503s when its handler is slow; a route
    //! merged AFTER (outside) the timeout is never severed â which is exactly
    //! how the realtime WS/SSE route is composed. (Note: the timeout
    //! times out the *response future*, so it cannot abort an
    //! already-streaming SSE body or an upgraded WS in the first place; merging
    //! the realtime route outside the timeout is belt-and-suspenders correctness
    //! that stays robust even if that behavior ever changes.)

    use std::time::Duration;

    use axum::Router;
    use axum::http::StatusCode;
    use axum::routing::get;
    use tower::ServiceExt;

    use crate::config::REQUEST_TIMEOUT;
    use crate::http::overload::with_timeout;

    async fn slow() -> &'static str {
        tokio::time::sleep(Duration::from_secs(2)).await;
        "done"
    }

    /// Mirrors `build_router`'s composition: a "timed" bundle wrapped by a short
    /// `TimeoutLayer`, then the realtime-equivalent route merged AFTER it.
    fn compose(timeout: Duration) -> Router {
        let timed = with_timeout(Router::new().route("/timed/slow", get(slow)), timeout);
        // The realtime route is merged AFTER the timeout layer, exactly as in
        // `build_router`, so it does not inherit the timeout.
        timed.merge(Router::new().route("/realtime/slow", get(slow)))
    }

    #[tokio::test]
    async fn domain_route_inside_timeout_is_shed_when_slow() {
        let app = compose(Duration::from_millis(200));
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/timed/slow")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "a slow handler on a route INSIDE the timeout layer must be shed with 503"
        );
    }

    #[tokio::test]
    async fn realtime_route_merged_outside_timeout_is_never_shed() {
        // Same short timeout, but the realtime-equivalent route is merged
        // outside it: a handler that runs well past the timeout still completes
        // 200 and is never severed. This is the #1 regression guard â a 30s
        // timeout must never cut a live realtime/SSE connection.
        let app = compose(Duration::from_millis(200));
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/realtime/slow")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "the realtime route is merged OUTSIDE the timeout and must not be timed out"
        );
    }

    #[test]
    fn default_request_timeout_is_thirty_seconds() {
        assert_eq!(REQUEST_TIMEOUT, Duration::from_secs(30));
    }
}
