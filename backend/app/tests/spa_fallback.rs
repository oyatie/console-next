#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! `CONSOLE_WEB_DIST` serves the built SPA as the router FALLBACK only.

use axum::body::{Body, to_bytes};
use console_app::{AppConfig, AppRole, AppState, DatabaseDependency, build_router};
use http::{Request, StatusCode, header};
use tower::ServiceExt;

const INDEX: &str = "<!doctype html><title>spa</title>";

fn router_with_storage(
    web_dist: Option<&std::path::Path>,
    storage_endpoint: Option<&str>,
) -> axum::Router {
    let mut pairs = vec![
        ("CONSOLE_APP_ROLE", AppRole::Api.to_string()),
        ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
    ];
    if let Some(dist) = web_dist {
        pairs.push(("CONSOLE_WEB_DIST", dist.display().to_string()));
    }
    if let Some(endpoint) = storage_endpoint {
        pairs.extend([
            ("CONSOLE_S3_ENDPOINT_URL", endpoint.to_owned()),
            ("CONSOLE_S3_ACCESS_KEY_ID", "test".to_owned()),
            ("CONSOLE_S3_SECRET_ACCESS_KEY", "test".to_owned()),
            ("CONSOLE_S3_PRIMARY_BUCKET", "photos".to_owned()),
            ("CONSOLE_S3_REPLICA_BUCKET", "photos-replica".to_owned()),
        ]);
    }
    let config = AppConfig::from_pairs(pairs).unwrap();
    build_router(AppState::new(config, DatabaseDependency::NotConfigured).unwrap())
}

fn router(web_dist: Option<&std::path::Path>) -> axum::Router {
    router_with_storage(web_dist, None)
}

fn dist() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("spa-dist-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join("assets")).unwrap();
    std::fs::write(dir.join("index.html"), INDEX).unwrap();
    std::fs::write(dir.join("assets/x.js"), "export {};").unwrap();
    dir
}

async fn get(router: &axum::Router, uri: &str) -> (StatusCode, http::HeaderMap, String) {
    let response = router
        .clone()
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let (parts, body) = response.into_parts();
    let body = to_bytes(body, usize::MAX).await.unwrap();
    (
        parts.status,
        parts.headers,
        String::from_utf8_lossy(&body).into_owned(),
    )
}

#[tokio::test]
async fn spa_is_served_as_fallback_with_cache_and_security_headers() {
    let dir = dist();
    let app = router(Some(&dir));

    for uri in ["/", "/org/changes"] {
        let (status, headers, body) = get(&app, uri).await;
        assert_eq!(status, StatusCode::OK, "{uri}");
        assert_eq!(body, INDEX, "{uri} must serve index.html");
        assert_eq!(headers[header::CACHE_CONTROL], "no-cache");
        let csp = headers[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
        assert!(csp.contains("default-src 'self'") && csp.contains("frame-ancestors 'none'"));
        assert!(csp.contains("connect-src 'self';"));
        assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(headers[header::REFERRER_POLICY], "same-origin");
        assert!(headers.contains_key(header::STRICT_TRANSPORT_SECURITY));
    }

    let (status, headers, body) = get(&app, "/assets/x.js").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, "export {};");
    assert_eq!(
        headers[header::CACHE_CONTROL],
        "public, max-age=31536000, immutable"
    );

    // A missing hashed asset is a real 404, never index.html cached forever.
    let (status, headers, body) = get(&app, "/assets/missing.js").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_ne!(body, INDEX);
    assert_eq!(headers[header::CACHE_CONTROL], "no-cache");

    // Unknown backend paths stay JSON 404s.
    let (status, headers, body) = get(&app, "/api/v1/does-not-exist").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_ne!(body, INDEX);
    assert_eq!(headers[header::CONTENT_TYPE], "application/json");
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["error"]["code"], "not_found");

    // Real routes keep precedence.
    let (status, _, body) = get(&app, "/healthz").await;
    assert_eq!(status, StatusCode::OK);
    assert_ne!(body, INDEX);

    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn spa_csp_allows_only_the_configured_object_store_origin() {
    let dir = dist();
    let app = router_with_storage(
        Some(&dir),
        Some("https://objects.example.test/storage/prefix"),
    );

    let (status, headers, _) = get(&app, "/").await;
    assert_eq!(status, StatusCode::OK);
    let csp = headers[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
    let connect = csp
        .split(';')
        .find(|directive| directive.trim_start().starts_with("connect-src "))
        .unwrap()
        .trim();
    assert_eq!(connect, "connect-src 'self' https://objects.example.test");
    assert!(!csp.contains("*"));
    assert!(!csp.contains("/storage"));

    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn spa_route_is_absent_when_web_dist_unset() {
    let app = router(None);
    for uri in ["/", "/org/changes"] {
        let (status, _, body) = get(&app, uri).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{uri}");
        assert_ne!(body, INDEX);
    }
}

/// One build's dist: `index` as index.html, mtime pinned to one instant
/// (the image's SOURCE_DATE_EPOCH is the same across web-only releases).
fn build(index: &str) -> std::path::PathBuf {
    let dir = dist();
    let file = dir.join("index.html");
    std::fs::write(&file, index).unwrap();
    let pinned = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
    for path in [file, dir.join("assets/x.js")] {
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(pinned)
            .unwrap();
    }
    dir
}

async fn get_with(
    router: &axum::Router,
    uri: &str,
    validator: (header::HeaderName, &str),
) -> (StatusCode, http::HeaderMap, String) {
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri(uri)
                .header(validator.0, validator.1)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let (parts, body) = response.into_parts();
    let body = to_bytes(body, usize::MAX).await.unwrap();
    (
        parts.status,
        parts.headers,
        String::from_utf8_lossy(&body).into_owned(),
    )
}

/// Regression (prod, 2026-10-08): after a blue/green promotion, build B
/// answered 304 to a browser revalidating build A's index.html with A's
/// validators (equal mtime, equal length), so it kept A's index, whose hashed
/// chunks were gone: a white screen. The validator must follow the content.
#[tokio::test]
async fn index_validators_follow_content_not_mtime_across_builds() {
    let (index_a, index_b) = (
        "<!doctype html><script src=/assets/a1.js>",
        "<!doctype html><script src=/assets/b2.js>",
    );
    assert_eq!(index_a.len(), index_b.len());
    let (dir_a, dir_b) = (build(index_a), build(index_b));
    let (app_a, app_b) = (router(Some(&dir_a)), router(Some(&dir_b)));

    for uri in ["/", "/some/route"] {
        let (status, headers_a, body) = get(&app_a, uri).await;
        assert_eq!((status, body.as_str()), (StatusCode::OK, index_a), "{uri}");
        let etag_a = headers_a[header::ETAG].to_str().unwrap().to_owned();
        assert!(etag_a.starts_with('"'), "{uri}: strong ETag, got {etag_a}");

        // (a) Build A's validators against build B: B's body, never 304.
        for validator in [
            (header::IF_MODIFIED_SINCE, "Tue, 14 Nov 2023 22:13:20 GMT"),
            (header::IF_NONE_MATCH, etag_a.as_str()),
        ] {
            let name = validator.0.clone();
            let (status, headers, body) = get_with(&app_b, uri, validator).await;
            assert_eq!(status, StatusCode::OK, "{uri} {name}");
            assert_eq!(body, index_b, "{uri} {name}");
            assert_ne!(headers[header::ETAG], etag_a.as_str(), "{uri} {name}");
            assert_eq!(headers[header::CACHE_CONTROL], "no-cache");
        }
        // Last-Modified is the image mtime, not the content: never sent.
        assert!(!headers_a.contains_key(header::LAST_MODIFIED), "{uri}");

        // (b) The same build with its own ETag (strong or W/-prefixed): 304,
        // still carrying the validator, no-cache and the security headers.
        let (_, headers_b, _) = get(&app_b, uri).await;
        let etag_b = headers_b[header::ETAG].to_str().unwrap().to_owned();
        for inm in [etag_b.clone(), format!("\"x\", W/{etag_b}")] {
            let (status, headers, body) =
                get_with(&app_b, uri, (header::IF_NONE_MATCH, &inm)).await;
            assert_eq!(status, StatusCode::NOT_MODIFIED, "{uri} {inm}");
            assert!(body.is_empty());
            assert_eq!(headers[header::ETAG], etag_b.as_str());
            assert_eq!(headers[header::CACHE_CONTROL], "no-cache");
            assert!(headers.contains_key(header::CONTENT_SECURITY_POLICY));
            assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
            assert!(!headers.contains_key(header::LAST_MODIFIED));
        }
    }

    // (d) Hashed assets keep the immutable branch; a missing one is a 404.
    let (status, headers, _) = get(&app_b, "/assets/x.js").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers[header::CACHE_CONTROL],
        "public, max-age=31536000, immutable"
    );
    let (status, _, body) = get(&app_b, "/assets/missing.js").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_ne!(body, index_b);

    std::fs::remove_dir_all(dir_a).unwrap();
    std::fs::remove_dir_all(dir_b).unwrap();
}
