use std::net::{IpAddr, Ipv4Addr};
use std::time::{Duration, Instant};

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use console_platform_request_context::TrustedClientIp;
use tower::ServiceExt;

use super::*;
use crate::http::metrics::install_metrics_recorder;

// Mounted as the fallback here: the OpenAPI census reads every route call in
// every app source, and the real mount is `routes::ops`.
fn router(web_dist: Option<&std::path::Path>) -> axum::Router {
    let mut config = crate::AppConfig::from_pairs(std::iter::empty::<(&str, &str)>()).unwrap();
    config.web_dist = web_dist.map(std::path::Path::to_path_buf);
    let state = crate::AppState::new(config, crate::DatabaseDependency::NotConfigured).unwrap();
    axum::Router::new().fallback_service(super::post::<()>(&state))
}

fn request(body: impl Into<Body>, ip: [u8; 4]) -> Request<Body> {
    let mut request = Request::post("/api/v1/client-errors")
        .header("content-type", "text/plain;charset=UTF-8")
        .header("sec-fetch-site", "same-origin")
        .body(body.into())
        .unwrap();
    request
        .extensions_mut()
        .insert(TrustedClientIp::new(IpAddr::V4(Ipv4Addr::from(ip))));
    request
}

fn beacon(kind: &str, build: &str) -> String {
    format!(r#"{{"kind":"{kind}","build":"{build}","route":"/people/:id","name":"TypeError"}}"#)
}

fn rendered() -> String {
    install_metrics_recorder().unwrap().render()
}

fn count(build: &str, kind: &str) -> usize {
    let needle = format!("{CLIENT_ERRORS_TOTAL}{{kind=\"{kind}\",build=\"{build}\"}}");
    rendered()
        .lines()
        .find(|line| line.starts_with(&needle))
        .and_then(|line| line.rsplit(' ').next()?.parse().ok())
        .unwrap_or(0)
}

#[tokio::test]
async fn a_beacon_is_counted_by_kind_and_build() {
    install_metrics_recorder().unwrap();
    let app = router(None);
    for kind in ["error", "rejection", "resource", "preload", "boot"] {
        let response = app
            .clone()
            .oneshot(request(beacon(kind, "ceA1"), [10, 0, 0, 1]))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT, "{kind}");
        assert_eq!(count("ceA1", kind), 1, "{kind}");
    }
}

#[tokio::test]
async fn garbage_free_text_and_unknown_kinds_are_refused_and_not_counted() {
    install_metrics_recorder().unwrap();
    let app = router(None);
    for body in [
        "not json".to_owned(),
        String::new(),
        beacon("crash", "ceB1"),
        // Free text never gets in: unknown fields are refused.
        r#"{"kind":"error","build":"ceB1","route":"/x","message":"홍길동 not found"}"#.to_owned(),
        // A query string, a raw id with spaces, a build past 16 chars.
        r#"{"kind":"error","build":"ceB1","route":"/people?q=kim"}"#.to_owned(),
        r#"{"kind":"error","build":"ceB1","route":"/people/kim chulsoo"}"#.to_owned(),
        r#"{"kind":"error","build":"ceB1","route":"people"}"#.to_owned(),
        beacon("error", "ceB1-0123456789abcdef"),
        r#"{"kind":"error","build":"ceB1","route":"/x","name":"Type Error: x"}"#.to_owned(),
    ] {
        let response = app
            .clone()
            .oneshot(request(body.clone(), [10, 0, 1, 1]))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{body}");
        let json = to_bytes(response.into_body(), 4096).await.unwrap();
        assert!(String::from_utf8_lossy(&json).contains("invalid_client_error"));
    }
    assert_eq!(count("ceB1", "error"), 0);
    assert!(!rendered().contains("홍길동"));
}

#[tokio::test]
async fn an_oversized_body_is_refused_413() {
    let app = router(None);
    let body = format!(
        r#"{{"kind":"error","build":"ceC1","route":"/{}"}}"#,
        "a".repeat(MAX_BODY_BYTES)
    );
    let response = app.oneshot(request(body, [10, 0, 2, 1])).await.unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(count("ceC1", "error"), 0);
}

#[tokio::test]
async fn a_cross_site_browser_post_is_refused() {
    let app = router(None);
    let mut request = request(beacon("error", "ceD1"), [10, 0, 3, 1]);
    request
        .headers_mut()
        .insert("sec-fetch-site", "cross-site".parse().unwrap());
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(count("ceD1", "error"), 0);
}

#[tokio::test]
async fn a_flood_from_one_ip_is_refused_429_and_other_ips_still_count() {
    install_metrics_recorder().unwrap();
    let app = router(None);
    for _ in 0..PER_IP_CAP {
        let response = app
            .clone()
            .oneshot(request(beacon("error", "ceE1"), [10, 0, 4, 1]))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
    }
    let refused = app
        .clone()
        .oneshot(request(beacon("error", "ceE1"), [10, 0, 4, 1]))
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(refused.headers()["retry-after"], "60");
    let other = app
        .oneshot(request(beacon("error", "ceE1"), [10, 0, 4, 2]))
        .await
        .unwrap();
    assert_eq!(other.status(), StatusCode::NO_CONTENT);
    assert_eq!(count("ceE1", "error"), PER_IP_CAP as usize + 1);
}

#[test]
fn the_global_cap_trips_and_the_window_resets() {
    let start = Instant::now();
    let mut limiter = Limiter::new(start);
    for n in 0..GLOBAL_CAP {
        // Many addresses, none over its own cap.
        assert_eq!(limiter.admit(Some(format!("ip{}", n % 100)), start), Ok(()));
    }
    assert_eq!(limiter.admit(Some("fresh".into()), start), Err(true));
    assert_eq!(limiter.admit(None, start), Err(true));
    let next = start + Duration::from_secs(60);
    assert_eq!(limiter.admit(Some("fresh".into()), next), Ok(()));
}

#[test]
fn builds_are_bounded_and_the_served_build_keeps_its_label() {
    let mut builds = Builds::default();
    assert_eq!(builds.label("own"), "own");
    for n in 1..MAX_BUILDS {
        assert_eq!(builds.label(&format!("b{n}")), format!("b{n}"));
    }
    assert_eq!(builds.label("flood1"), "other");
    assert_eq!(builds.label("own"), "own");
    assert_eq!(builds.label("b3"), "b3");
}

#[test]
fn the_served_build_is_the_entry_hash() {
    let html = r#"<script type="module" crossorigin src="/assets/index-CFeM_C0T.js"></script>"#;
    assert_eq!(dist_build(html), Some("CFeM_C0T"));
    assert_eq!(dist_build(r#"<script src="/src/main.tsx">"#), None);
    assert_eq!(dist_build(r#"src="/assets/index-a b.js""#), None);
}

#[test]
fn the_served_dist_publishes_its_build_info() {
    install_metrics_recorder().unwrap();
    let dist = std::env::temp_dir().join(format!("ce-dist-{}", std::process::id()));
    std::fs::create_dir_all(&dist).unwrap();
    std::fs::write(
        dist.join("index.html"),
        r#"<script src="/assets/index-ceF1own.js">"#,
    )
    .unwrap();
    let _app = router(Some(&dist));
    std::fs::remove_dir_all(&dist).unwrap();
    assert!(rendered().contains(&format!("{WEB_BUILD_INFO}{{build=\"ceF1own\"}} 1")));
}

#[tokio::test]
async fn a_beacon_carries_release_and_is_counted_per_release() {
    install_metrics_recorder().unwrap();
    let app = router(None);
    let body = r#"{"kind":"error","build":"ceRel1","release":"v2026.10.20","route":"/people/:id","name":"TypeError"}"#;
    let response = app
        .clone()
        .oneshot(request(body.to_owned(), [10, 0, 5, 1]))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let needle =
        format!("{CLIENT_ERRORS_BY_RELEASE_TOTAL}{{release=\"v2026.10.20\",kind=\"error\"}}");
    let count: usize = rendered()
        .lines()
        .find(|line| line.starts_with(&needle))
        .and_then(|line| line.rsplit(' ').next()?.parse().ok())
        .unwrap_or(0);
    assert_eq!(count, 1);
}

#[tokio::test]
async fn release_labels_are_bounded_even_when_clients_send_distinct_releases() {
    install_metrics_recorder().unwrap();
    let app = router(None);
    for i in 0..MAX_BUILDS + 3 {
        let body = format!(
            r#"{{"kind":"error","build":"boundedrel","release":"attacker-{i}","route":"/"}}"#
        );
        assert_eq!(
            app.clone()
                .oneshot(request(body, [10, 8, 8, 8]))
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );
    }
    let lines = rendered();
    let releases: Vec<_> = lines
        .lines()
        .filter(|l| l.starts_with(CLIENT_ERRORS_BY_RELEASE_TOTAL) && l.contains("attacker-"))
        .collect();
    assert!(releases.len() <= MAX_BUILDS, "{releases:?}");
    assert!(
        lines
            .lines()
            .any(|l| l.starts_with(CLIENT_ERRORS_BY_RELEASE_TOTAL)
                && l.contains("release=\"other\""))
    );
}

#[tokio::test]
async fn requesting_a_reference_does_not_count_a_phantom_boot_or_client_error() {
    install_metrics_recorder().unwrap();
    let app = router(None);
    let mut req = request(
        r#"{"kind":"reference","build":"referenceOnly","route":"/"}"#.to_owned(),
        [10, 9, 7, 1],
    );
    req.headers_mut()
        .insert("accept", HeaderValue::from_static("application/json"));
    let response = app.oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    assert!(
        !rendered()
            .lines()
            .any(|line| line.starts_with(CLIENT_ERRORS_TOTAL) && line.contains("referenceOnly"))
    );
    assert!(
        !rendered()
            .lines()
            .any(|line| line.starts_with(CLIENT_ERRORS_BY_RELEASE_TOTAL)
                && line.contains("referenceOnly"))
    );
}
