//! Public synthetic evidence. No tenant reads, principal, writes or internal names.
//!
//! Cedar exemption: both routes are unauthenticated and tenant-free, so there is no principal or
//! tenant resource to decide on. They read one global aggregate (the dispatch worker's age) and
//! the listener's liveness; the tests below prove the bodies carry no tenant data.
use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

use crate::state::{AppState, DatabaseDependency};

pub(crate) const STATUS_ROUTE_PATHS: &[&str] =
    &["/api/v1/status/evidence", "/api/v1/status/events"];

pub(crate) async fn evidence(State(state): State<AppState>) -> Response {
    let DatabaseDependency::Postgres(pool) = &state.database else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    match console_platform_jobs::status::worker_age_seconds(pool).await {
        Ok(age) => {
            Json(serde_json::json!({"schema": 1, "worker_age_seconds": age})).into_response()
        }
        Err(error) => {
            tracing::warn!(error = %error, "public worker evidence unavailable");
            StatusCode::SERVICE_UNAVAILABLE.into_response()
        }
    }
}

pub(crate) async fn events(State(state): State<AppState>) -> Response {
    match state.realtime_hub {
        Some(hub) => console_platform_realtime::status::heartbeat(hub).await,
        None => StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{Body, to_bytes};
    use axum::http::Request;
    use tower::ServiceExt;

    #[tokio::test]
    async fn status_public_routes_refuse_missing_evidence_and_writes() {
        let config =
            crate::config::AppConfig::from_pairs([("CONSOLE_HTTP_ADDR", "127.0.0.1:0")]).unwrap();
        let app = crate::routes::build_router(
            AppState::new(config, DatabaseDependency::NotConfigured).unwrap(),
        );
        for path in STATUS_ROUTE_PATHS {
            let response = app
                .clone()
                .oneshot(Request::get(*path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(response.headers()["cache-control"], "no-store");
            let body = to_bytes(response.into_body(), 4096).await.unwrap();
            let text = String::from_utf8(body.to_vec()).unwrap();
            assert!(!text.contains("apalis") && !text.contains("worker_type"));
            let response = app
                .clone()
                .oneshot(Request::post(*path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
        }
    }

    #[cfg(feature = "test-postgres")]
    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn status_public_stream_reaches_listener_through_the_product_router(pool: sqlx::PgPool) {
        let config =
            crate::config::AppConfig::from_pairs([("CONSOLE_HTTP_ADDR", "127.0.0.1:0")]).unwrap();
        let state = AppState::new(config, DatabaseDependency::Postgres(pool)).unwrap();
        let hub = state.realtime_hub.clone().unwrap();
        let bridge = hub.start_postgres_listener().await.unwrap();
        let app = crate::routes::build_router(state);
        let response = app
            .clone()
            .oneshot(
                Request::get(STATUS_ROUTE_PATHS[1])
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], "text/event-stream");
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert_eq!(
            &to_bytes(response.into_body(), 1024).await.unwrap()[..],
            b": heartbeat\n\n"
        );
        let response = app
            .oneshot(
                Request::get(STATUS_ROUTE_PATHS[0])
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "absent worker registry cannot be green"
        );
        bridge.shutdown();
    }

    #[cfg(feature = "test-postgres")]
    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn status_public_evidence_answers_aggregate_age_only_beside_tenant_data(
        pool: sqlx::PgPool,
    ) {
        let org = uuid::Uuid::new_v4();
        console_platform_test_support::seed_org_and_super_admin(&pool, org, "status-tenant").await;
        // The worker registry is the apalis schema, which only its owner role migrates.
        let statement: String = sqlx::query_scalar(
            "SELECT format('ALTER DATABASE %I OWNER TO console_app', current_database())",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        sqlx::raw_sql(sqlx::AssertSqlSafe(statement))
            .execute(&pool)
            .await
            .unwrap();
        let mut owner = pool.acquire().await.unwrap().detach();
        sqlx::query("SET SESSION AUTHORIZATION console_app")
            .execute(&mut owner)
            .await
            .unwrap();
        console_platform_jobs::migrate_and_reconcile_apalis_postgres(&mut owner)
            .await
            .unwrap();
        drop(owner);
        let worker = format!("worker-{org}");
        sqlx::query(
            "INSERT INTO apalis.workers (id, worker_type, storage_name, last_seen) \
             VALUES ($1, $2, 'status-storage', NOW())",
        )
        .bind(&worker)
        .bind(console_platform_jobs::status::DISPATCH_QUEUE)
        .execute(&pool)
        .await
        .unwrap();
        let config =
            crate::config::AppConfig::from_pairs([("CONSOLE_HTTP_ADDR", "127.0.0.1:0")]).unwrap();
        let app = crate::routes::build_router(
            AppState::new(config, DatabaseDependency::Postgres(pool)).unwrap(),
        );
        let response = app
            .oneshot(
                Request::get(STATUS_ROUTE_PATHS[0])
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let text = String::from_utf8(to_bytes(response.into_body(), 4096).await.unwrap().to_vec())
            .unwrap();
        let body: serde_json::Value = serde_json::from_str(&text).unwrap();
        let age = body["worker_age_seconds"].as_i64().unwrap();
        assert!((0..=5).contains(&age), "{age}");
        assert_eq!(
            body,
            serde_json::json!({"schema": 1, "worker_age_seconds": age})
        );
        let slug = format!("org-{}", &org.simple().to_string()[..12]);
        for private in [
            org.to_string().as_str(),
            slug.as_str(),
            "status-tenant",
            worker.as_str(),
            "status-storage",
            console_platform_jobs::status::DISPATCH_QUEUE,
        ] {
            assert!(!text.contains(private), "{private} leaked: {text}");
        }
    }
}
