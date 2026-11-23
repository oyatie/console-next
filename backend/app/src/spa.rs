//! The SPA (`CONSOLE_WEB_DIST`) fallback.

use axum::Json;
use axum::body::Body;
use axum::http::{HeaderMap, HeaderValue, Request, Response, StatusCode, header};
use axum::response::IntoResponse;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::Arc;
use tower::ServiceExt;

/// Paths the SPA must never answer: unknown backend URLs stay JSON 404s
/// instead of silently becoming `index.html`.
const SPA_EXCLUDED_PREFIXES: &[&str] = &["/api/", "/openapi/", "/internal/", "/.well-known/"];
const SPA_EXCLUDED_PATHS: &[&str] = &["/api", "/healthz", "/readyz", "/metrics"];
const SPA_CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; \
    font-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'";

fn sanitize_csp_origin(raw: &str) -> Option<String> {
    if raw.bytes().any(|b| {
        b.is_ascii_control()
            || b.is_ascii_whitespace()
            || matches!(b, b';' | b',' | b'*' | b'\'' | b'"' | b'\\')
    }) {
        return None;
    }
    let parsed = url::Url::parse(raw).ok()?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !matches!(parsed.origin(), url::Origin::Tuple(..))
        || parsed.port() == Some(0)
        || parsed
            .host_str()
            .is_none_or(|h| h.is_empty() || h.contains('*'))
    {
        return None;
    }
    let origin = parsed.origin().ascii_serialization();
    if origin.bytes().any(|b| {
        b.is_ascii_control()
            || b.is_ascii_whitespace()
            || matches!(b, b';' | b',' | b'*' | b'\'' | b'"' | b'\\')
    }) {
        return None;
    }
    Some(origin)
}

pub(crate) fn spa_csp(
    storage: Option<&console_platform_storage::S3StorageConfig>,
    status_origin: Option<&str>,
) -> HeaderValue {
    let mut tokens = vec!["'self'".to_owned()];
    if let Some(origin) = status_origin.and_then(sanitize_csp_origin)
        && !tokens.contains(&origin)
    {
        tokens.push(origin);
    }
    if let Some(origin) = storage.and_then(|s| sanitize_csp_origin(&s.endpoint_url))
        && !tokens.contains(&origin)
    {
        tokens.push(origin);
    }
    let policy = SPA_CSP.replace(
        "connect-src 'self'",
        &format!("connect-src {}", tokens.join(" ")),
    );
    HeaderValue::try_from(policy).unwrap_or_else(|_| HeaderValue::from_static(SPA_CSP))
}

/// The validator for every non-`/assets/` response: a strong ETag over the
/// whole dist's bytes (RFC 9110 §8.8.3), computed once per router (the dist is
/// immutable inside a running image). One tag for all paths changes whenever
/// any served byte does, with no need to know which file ServeDir resolved.
/// The file mtime is the image's SOURCE_DATE_EPOCH, equal across web-only
/// releases, so neither Last-Modified nor tower-http's mtime+size ETag tells
/// two builds apart (a stale index.html got 304, then a white screen).
/// `None` (unreadable dist): no validator, so every request gets a 200.
pub(crate) fn dist_etag(dist: &Path) -> Option<HeaderValue> {
    fn feed(root: &Path, dir: &Path, hasher: &mut Sha256) -> std::io::Result<()> {
        let mut paths = std::fs::read_dir(dir)?
            .map(|entry| entry.map(|entry| entry.path()))
            .collect::<std::io::Result<Vec<_>>>()?;
        paths.sort();
        for path in paths {
            if path.is_dir() {
                feed(root, &path, hasher)?;
            } else {
                let name = path.strip_prefix(root).unwrap_or(&path);
                hasher.update(name.as_os_str().as_encoded_bytes());
                hasher.update([0]);
                hasher.update(std::fs::read(&path)?);
            }
        }
        Ok(())
    }
    let mut hasher = Sha256::new();
    match feed(dist, dist, &mut hasher) {
        Ok(()) => HeaderValue::try_from(format!("\"{}\"", hex::encode(hasher.finalize()))).ok(),
        Err(err) => {
            tracing::error!(error = %err, "hashing the SPA dist failed; serving it without validators");
            None
        }
    }
}

/// RFC 9110 §13.1.2: If-None-Match uses weak comparison (`W/` ignored);
/// `*` matches any current representation.
fn none_match(request: &HeaderMap, etag: &HeaderValue) -> bool {
    request
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .any(|tag| {
            tag == "*" || tag.strip_prefix("W/").unwrap_or(tag).as_bytes() == etag.as_bytes()
        })
}

pub(crate) async fn serve_spa(
    dist: Arc<Path>,
    etag: Option<HeaderValue>,
    hsts: bool,
    csp: HeaderValue,
    mut request: Request<Body>,
) -> Response<Body> {
    use tower_http::services::{ServeDir, ServeFile};
    let path = request.uri().path().to_owned();
    if SPA_EXCLUDED_PATHS.contains(&path.as_str())
        || SPA_EXCLUDED_PREFIXES
            .iter()
            .any(|prefix| path.starts_with(prefix))
    {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": {"code": "not_found", "message": "no such route"}})),
        )
            .into_response();
    }
    // Vite content-hashed bundles: a missing one is a real 404 (never
    // index.html, which would then be cached as immutable JS).
    let immutable = path.starts_with("/assets/");
    // Everything else is revalidated against `etag` alone. ServeDir judges
    // these conditionals by mtime inside the service (a 304 or 412 before we
    // see the response), so they never reach it; If-Modified-Since is
    // ignored as Last-Modified is never sent (RFC 9110 §13.1.3).
    let mut not_modified = false;
    if !immutable {
        let conditionals = request.headers_mut();
        not_modified = etag
            .as_ref()
            .is_some_and(|etag| none_match(conditionals, etag));
        for name in [
            header::IF_NONE_MATCH,
            header::IF_MODIFIED_SINCE,
            header::IF_MATCH,
            header::IF_UNMODIFIED_SINCE,
        ] {
            conditionals.remove(name);
        }
    }
    // Use the service's expected-I/O-to-404 mapping; try_call propagates those
    // errors since 0.7.1: https://github.com/tower-rs/tower-http/pull/718.
    let served = if immutable {
        ServeDir::new(&*dist).oneshot(request).await
    } else {
        ServeDir::new(&*dist)
            .fallback(ServeFile::new(dist.join("index.html")))
            .oneshot(request)
            .await
    };
    let mut response = match served {
        Ok(response) => response.map(Body::new),
        Err(err) => match err {},
    };
    if !immutable {
        let found = response.status() == StatusCode::OK;
        if found && not_modified {
            response = StatusCode::NOT_MODIFIED.into_response();
        }
        let headers = response.headers_mut();
        headers.remove(header::LAST_MODIFIED);
        headers.remove(header::ETAG);
        if let Some(etag) = etag.filter(|_| found) {
            headers.insert(header::ETAG, etag);
        }
    }
    let cache = if immutable && response.status().is_success() {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let headers = response.headers_mut();
    headers.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static(cache),
    );
    if headers
        .get(header::CONTENT_TYPE)
        .is_some_and(|value| value == "text/html")
    {
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/html; charset=utf-8"),
        );
    }
    headers.insert(header::CONTENT_SECURITY_POLICY, csp);
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        header::HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        header::HeaderValue::from_static("same-origin"),
    );
    if hsts {
        headers.insert(
            header::STRICT_TRANSPORT_SECURITY,
            header::HeaderValue::from_static("max-age=31536000; includeSubDomains"),
        );
    }
    // B-02: the request metric labels what the SPA served (it has no matched
    // route), so a missing bundle or a failing document is visible to the SLO.
    let label = if immutable { "/assets/*" } else { "/" };
    response
        .extensions_mut()
        .insert(crate::http::metrics::StaticRoute(label));
    response
}

#[cfg(test)]
mod tests {
    use super::spa_csp;
    use console_platform_storage::S3StorageConfig;

    fn storage(endpoint_url: &str) -> S3StorageConfig {
        S3StorageConfig {
            endpoint_url: endpoint_url.to_owned(),
            access_key_id: "test".to_owned(),
            secret_access_key: "test".to_owned(),
            primary_bucket: "a".to_owned(),
            replica_bucket: "b".to_owned(),
            region: "ap-northeast-2".to_owned(),
            force_path_style: true,
        }
    }

    #[test]
    fn spa_csp_drops_unsafe_status_origin_and_deduplicates_origins() {
        let csp = spa_csp(None, Some("https://evil.test; script-src 'unsafe-inline'"));
        assert!(csp.to_str().unwrap().contains("connect-src 'self';"));

        let s3 = storage("https://status.example.test/bucket");
        let dedup = spa_csp(Some(&s3), Some("https://status.example.test"));
        assert!(
            dedup
                .to_str()
                .unwrap()
                .contains("connect-src 'self' https://status.example.test;")
        );

        let zero_port_s3 = storage("https://objects.example.test:0");
        let dropped = spa_csp(Some(&zero_port_s3), Some("https://status.example.test:0"));
        assert!(dropped.to_str().unwrap().contains("connect-src 'self';"));
    }
}
