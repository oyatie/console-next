// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Integration tests for `CONSOLE_STATUS_ORIGIN` validation and `SPA_CSP` `connect-src`.

use axum::body::Body;
use console_app::{AppConfig, AppRole, AppState, DatabaseDependency, build_router};
use http::{Request, StatusCode, header};
use tower::ServiceExt;

fn dist() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("spa-csp-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("index.html"), "<!doctype html><title>spa</title>").unwrap();
    dir
}

async fn connect_src(extra: &[(&str, &str)], storage_endpoint: Option<&str>) -> String {
    let dir = dist();
    let mut pairs = vec![
        ("CONSOLE_APP_ROLE", AppRole::Api.to_string()),
        ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
        ("CONSOLE_WEB_DIST", dir.display().to_string()),
    ];
    if let Some(endpoint) = storage_endpoint {
        pairs.extend([
            ("CONSOLE_S3_ENDPOINT_URL", endpoint.to_owned()),
            ("CONSOLE_S3_ACCESS_KEY_ID", "test".to_owned()),
            ("CONSOLE_S3_SECRET_ACCESS_KEY", "test".to_owned()),
            ("CONSOLE_S3_PRIMARY_BUCKET", "photos".to_owned()),
            ("CONSOLE_S3_REPLICA_BUCKET", "photos-replica".to_owned()),
        ]);
    }
    for (k, v) in extra {
        pairs.push((k, (*v).to_owned()));
    }
    let config = AppConfig::from_pairs(pairs).unwrap();
    let app = build_router(AppState::new(config, DatabaseDependency::NotConfigured).unwrap());
    let response = app
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let csp = response.headers()[header::CONTENT_SECURITY_POLICY]
        .to_str()
        .unwrap()
        .to_owned();
    assert!(csp.contains("script-src 'self';"));
    assert!(csp.contains("frame-ancestors 'none';"));
    std::fs::remove_dir_all(dir).unwrap();
    csp.split(';')
        .find(|d| d.trim_start().starts_with("connect-src "))
        .unwrap()
        .trim()
        .to_owned()
}

#[tokio::test]
async fn defaults_overrides_none_and_deduplicates_connect_src() {
    assert_eq!(
        connect_src(&[], None).await,
        "connect-src 'self' https://status.cosskorea.com"
    );
    assert_eq!(
        connect_src(&[("CONSOLE_STATUS_ORIGIN", "   ")], None).await,
        "connect-src 'self' https://status.cosskorea.com"
    );
    assert_eq!(
        connect_src(
            &[("CONSOLE_STATUS_ORIGIN", "https://STATUS.Example.Test:443")],
            None
        )
        .await,
        "connect-src 'self' https://status.example.test"
    );
    assert_eq!(
        connect_src(
            &[("CONSOLE_STATUS_ORIGIN", "https://status.example.test:8443")],
            None
        )
        .await,
        "connect-src 'self' https://status.example.test:8443"
    );
    assert_eq!(
        connect_src(&[("CONSOLE_STATUS_ORIGIN", "none")], None).await,
        "connect-src 'self'"
    );
    assert_eq!(
        connect_src(
            &[("CONSOLE_STATUS_ORIGIN", "none")],
            Some("https://objects.example.test/bucket")
        )
        .await,
        "connect-src 'self' https://objects.example.test"
    );
    assert_eq!(
        connect_src(
            &[("CONSOLE_STATUS_ORIGIN", "https://objects.example.test")],
            Some("https://objects.example.test/bucket")
        )
        .await,
        "connect-src 'self' https://objects.example.test"
    );
    assert_eq!(
        connect_src(
            &[("CONSOLE_STATUS_ORIGIN", "none")],
            Some("https://objects.example.test:0")
        )
        .await,
        "connect-src 'self'"
    );
}

#[tokio::test]
async fn allows_loopback_http_only_when_cookie_secure_is_false() {
    for origin in [
        "http://127.0.0.1:4173",
        "http://localhost:4173",
        "http://[::1]:4173",
    ] {
        assert_eq!(
            connect_src(
                &[
                    ("CONSOLE_COOKIE_SECURE", "false"),
                    ("CONSOLE_STATUS_ORIGIN", origin),
                ],
                None
            )
            .await,
            format!("connect-src 'self' {origin}")
        );
        assert!(
            AppConfig::from_pairs([("CONSOLE_STATUS_ORIGIN", origin)]).is_err(),
            "production default must reject {origin}"
        );
    }
}

#[test]
fn rejects_csp_injection_and_disallowed_origins_without_raw_echo() {
    let cases = [
        (
            None,
            "https://status.cosskorea.com; script-src 'unsafe-inline'",
        ),
        (None, "https://status.cosskorea.com https://evil.example"),
        (None, "https://status.cosskorea.com\r\nX-Test: 1"),
        (None, "https://status.cosskorea.com\n"),
        (None, "https://status.cosskorea.com\0"),
        (None, "https://*.cosskorea.com"),
        (None, "*"),
        (None, "https://status.cosskorea.com/"),
        (None, "https://status.cosskorea.com/active.json"),
        (None, "https://status.cosskorea.com?x=1"),
        (None, "https://status.cosskorea.com#frag"),
        (None, "https://user:pass@status.cosskorea.com"),
        (None, "https://@status.cosskorea.com"),
        (None, "https://status.cosskorea.com%3B"),
        (None, "https://status.cosskorea.com\u{FF1B}evil.test"),
        (None, "https://status%2C.cosskorea.com"),
        (None, "https://status%27.cosskorea.com"),
        (None, "https://status%22.cosskorea.com"),
        (None, "https://status.cosskorea.com:0"),
        (None, "https://status.cosskorea.com/."),
        (None, "https://status.cosskorea.com/.."),
        (None, "javascript:alert(1)"),
        (None, "data:text/plain,ok"),
        (None, "wss://status.cosskorea.com"),
        (None, "file:///etc/hosts"),
        (Some("true"), "http://127.0.0.1:4173"),
        (Some("false"), "http://status.cosskorea.com"),
        (Some("false"), "http://10.0.0.5:8080"),
    ];
    for (cookie_secure, payload) in cases {
        let mut pairs = vec![("CONSOLE_STATUS_ORIGIN", payload)];
        if let Some(flag) = cookie_secure {
            pairs.push(("CONSOLE_COOKIE_SECURE", flag));
        }
        let err = AppConfig::from_pairs(pairs).unwrap_err().to_string();
        assert!(!err.contains("evil.example"), "raw echoed: {err}");
        assert!(!err.contains("unsafe-inline"), "raw echoed: {err}");
        assert!(!err.contains("user:pass"), "raw echoed: {err}");
        assert!(!err.contains("10.0.0.5"), "raw echoed: {err}");
    }
}
