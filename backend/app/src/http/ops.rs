//! Health, readiness, OpenAPI and well-known association endpoints.

use crate::config::role::AppRole;
use crate::state::AppState;
use crate::state::DatabaseDependency;
use axum::Json;
use axum::body::Body;
use axum::extract::State;
use axum::http::{Response, StatusCode, header};
use axum::response::IntoResponse;
use console_platform_auth::{
    AndroidAssetLinksConfig, AppleAppSiteAssociationConfig, android_assetlinks_json,
    apple_app_site_association_json,
};
use serde::Serialize;
use tracing::Instrument;

const OPENAPI_YAML: &str = include_str!("../../../openapi/openapi.yaml");

#[derive(Debug, Serialize)]
struct HealthBody<'a> {
    status: &'a str,
    service: String,
    role: AppRole,
}

#[derive(Debug, Serialize)]
struct ReadyBody<'a> {
    status: &'a str,
    write_ready: bool,
    service: String,
    role: AppRole,
    database: &'a str,
    leave_command_database: &'a str,
    ontology_command_database: &'a str,
    platform_force_command_database: &'a str,
}

pub(crate) async fn healthz(State(state): State<AppState>) -> impl IntoResponse {
    Json(HealthBody {
        status: "ok",
        service: state.config.service_name,
        role: state.config.role,
    })
}

pub(crate) async fn readyz(State(state): State<AppState>) -> impl IntoResponse {
    let database = readiness_dependency_status(&state.database, "runtime").await;
    let command_databases_required = state.config.role == AppRole::Api
        && matches!(state.database, DatabaseDependency::Postgres(_));
    let leave_command_database =
        readiness_dependency_status(&state.leave_command_database, "leave_command").await;
    let ontology_command_database =
        readiness_dependency_status(&state.ontology_command_database, "ontology_command").await;
    let platform_force_command_database = readiness_dependency_status(
        &state.platform_force_command_database,
        "platform_force_command",
    )
    .await;

    // BG-8: after SIGTERM the proxy must stop routing here before the listener closes.
    let draining = state.draining.load(std::sync::atomic::Ordering::Relaxed);
    let ready = !draining
        && database.healthy()
        && (!command_databases_required
            || (leave_command_database.configured
                && leave_command_database.ready
                && ontology_command_database.configured
                && ontology_command_database.ready
                && platform_force_command_database.configured
                && platform_force_command_database.ready));
    let status = if ready {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (
        status,
        Json(ReadyBody {
            status: match (draining, ready) {
                (true, _) => "draining",
                (false, true) => "ready",
                (false, false) => "not_ready",
            },
            // True requires separate fenced writer authority and operation-bound two-site proof.
            write_ready: false,
            service: state.config.service_name,
            role: state.config.role,
            database: database.label,
            leave_command_database: leave_command_database.label,
            ontology_command_database: ontology_command_database.label,
            platform_force_command_database: platform_force_command_database.label,
        }),
    )
}

#[derive(Debug, Clone, Copy)]
struct ReadinessDependencyStatus {
    configured: bool,
    ready: bool,
    label: &'static str,
}

impl ReadinessDependencyStatus {
    fn healthy(self) -> bool {
        !self.configured || self.ready
    }
}

async fn readiness_dependency_status(
    dependency: &DatabaseDependency,
    dependency_name: &'static str,
) -> ReadinessDependencyStatus {
    match dependency {
        DatabaseDependency::NotConfigured => ReadinessDependencyStatus {
            configured: false,
            ready: false,
            label: "not_configured",
        },
        DatabaseDependency::Postgres(pool) => {
            let ready = sqlx::query("SELECT 1")
                // rls-arming: ok readiness health probe is SELECT 1 (non-tenant, non-RLS)
                .execute(pool)
                .instrument(tracing::info_span!(
                    "db.readiness",
                    db_system = "postgresql",
                    db_operation = "SELECT",
                    db_statement = "SELECT 1",
                    dependency = dependency_name,
                ))
                .await
                .is_ok();
            ReadinessDependencyStatus {
                configured: true,
                ready,
                label: if ready { "ready" } else { "unreachable" },
            }
        }
    }
}

pub(crate) async fn openapi_yaml() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "application/yaml; charset=utf-8")],
        OPENAPI_YAML,
    )
}

/// Serve the Apple App Site Association document at the well-known path.
///
/// Public + unauthenticated, served as `application/json` (no extension, per
/// Apple's requirement). The `webcredentials.apps` list is sourced from
/// `CONSOLE_IOS_APP_IDS`; an empty list yields a valid but inert document. Apple
/// fetches this over the RP origin to authorize the native app's passkeys.
pub(crate) async fn apple_app_site_association(State(state): State<AppState>) -> Response<Body> {
    let body = apple_app_site_association_json(AppleAppSiteAssociationConfig {
        app_ids: state.config.app_links.ios_app_ids.clone(),
    });
    well_known_json_response(body)
}

/// Serve the Android Digital Asset Links document at `/.well-known/assetlinks.json`.
///
/// Public + unauthenticated, served as `application/json`. The package +
/// signing-cert fingerprints come from `CONSOLE_ANDROID_PACKAGE` /
/// `CONSOLE_ANDROID_CERT_SHA256`; when the package is unset the document is an empty
/// JSON array (valid + inert). Android fetches this to authorize the app's
/// passkeys for the RP domain.
pub(crate) async fn android_assetlinks(State(state): State<AppState>) -> Response<Body> {
    let links = &state.config.app_links;
    let body = match &links.android_package {
        Some(package_name) => android_assetlinks_json(AndroidAssetLinksConfig {
            package_name: package_name.clone(),
            sha256_cert_fingerprints: links.android_cert_sha256.clone(),
        }),
        // No package configured yet: serve an empty (but valid) asset-links array
        // rather than a half-populated entry with no package name.
        None => Ok("[]".to_owned()),
    };
    well_known_json_response(body)
}

/// Build an `application/json` response for a well-known association document.
///
/// Serialization of these tiny, statically-shaped documents cannot realistically
/// fail; if it ever did we surface a 500 rather than serving a malformed body.
fn well_known_json_response(
    body: Result<String, console_platform_auth::AuthError>,
) -> Response<Body> {
    match body {
        Ok(json) => ([(header::CONTENT_TYPE, "application/json")], json).into_response(),
        Err(err) => {
            tracing::error!(error = %err, "failed to serialize well-known association document");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

// Every test in this module is `#[cfg(feature = "test-postgres")]`, so without
// that feature the whole module is helpers and imports with no consumer.
#[cfg(all(test, feature = "test-postgres"))]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod readiness_tests {
    use axum::extract::State;
    use axum::response::IntoResponse;
    use http::StatusCode;
    use sqlx::PgPool;
    use sqlx::postgres::PgPoolOptions;

    use super::readyz;
    use crate::config::AppConfig;
    use crate::config::role::AppRole;
    use crate::state::AppState;
    use crate::state::DatabaseDependency;

    fn api_config() -> AppConfig {
        AppConfig::from_pairs([
            ("CONSOLE_APP_ROLE", AppRole::Api.to_string()),
            ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
        ])
        .expect("valid api test config")
    }

    async fn separate_pool(pool: &PgPool) -> PgPool {
        PgPoolOptions::new()
            .max_connections(1)
            .connect_with(pool.connect_options().as_ref().clone())
            .await
            .expect("separate readiness pool connects")
    }

    #[cfg(feature = "test-postgres")]
    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn api_readiness_fails_closed_when_either_command_pool_degrades(pool: PgPool) {
        let leave = separate_pool(&pool).await;
        let ontology = separate_pool(&pool).await;
        let platform_force = separate_pool(&pool).await;
        let mut state =
            AppState::new(api_config(), DatabaseDependency::Postgres(pool)).expect("state builds");
        state.leave_command_database = DatabaseDependency::Postgres(leave.clone());
        state.ontology_command_database = DatabaseDependency::Postgres(ontology);
        state.platform_force_command_database = DatabaseDependency::Postgres(platform_force);

        let healthy = readyz(State(state.clone())).await.into_response();
        assert_eq!(healthy.status(), StatusCode::OK);

        leave.close().await;
        let degraded = readyz(State(state)).await.into_response();
        assert_eq!(degraded.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}
