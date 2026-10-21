//! B-02: what the SPA fallback serves is labelled (`/assets/*`, `/`), not
//! `/_unmatched`, so a missing bundle or a failing document reaches the SLO.
//! B-01: the client error beacon answers through the full router.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::body::Body;
use console_app::{
    AppConfig, AppState, DatabaseDependency, build_router, install_metrics_recorder,
};
use http::{Request, StatusCode};
use tower::ServiceExt;

fn app(service: &str, dist: &std::path::Path) -> axum::Router {
    let config = AppConfig::from_pairs([
        ("CONSOLE_SERVICE_NAME", service.to_owned()),
        ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
        ("CONSOLE_WEB_DIST", dist.display().to_string()),
    ])
    .unwrap();
    build_router(AppState::new(config, DatabaseDependency::NotConfigured).unwrap())
}

fn series(service: &str, route: &str, status: u16) -> bool {
    let needle = format!("http_route=\"{route}\",http_response_status_code=\"{status}\"");
    install_metrics_recorder()
        .unwrap()
        .render()
        .lines()
        .any(|line| line.contains(&format!("service_name=\"{service}\"")) && line.contains(&needle))
}

#[tokio::test]
async fn spa_files_carry_static_route_labels() {
    install_metrics_recorder().unwrap();
    let dist = std::env::temp_dir().join(format!("b02-dist-{}", std::process::id()));
    std::fs::create_dir_all(dist.join("assets")).unwrap();
    std::fs::write(
        dist.join("index.html"),
        "<!doctype html><div id=root></div>",
    )
    .unwrap();
    std::fs::write(dist.join("assets/index-b02.js"), "export {}").unwrap();
    let service = "b02-static-routes";
    let app = app(service, &dist);

    for (uri, status) in [
        ("/assets/index-b02.js", StatusCode::OK),
        ("/assets/index-gone.js", StatusCode::NOT_FOUND),
        ("/people/123?tab=x", StatusCode::OK),
        ("/api/v1/no-such-route", StatusCode::NOT_FOUND),
    ] {
        let response = app
            .clone()
            .oneshot(Request::get(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), status, "{uri}");
    }
    std::fs::remove_dir_all(&dist).unwrap();

    assert!(
        series(service, "/assets/*", 200),
        "a served bundle is /assets/*"
    );
    assert!(
        series(service, "/assets/*", 404),
        "a missing bundle is /assets/* 404"
    );
    assert!(series(service, "/", 200), "the document is /");
    assert!(
        series(service, "/_unmatched", 404),
        "an unknown API path keeps the sentinel"
    );
    let text = install_metrics_recorder().unwrap().render();
    assert!(
        !text.contains("index-gone") && !text.contains("/people/123") && !text.contains("tab=x")
    );
}

#[tokio::test]
async fn the_client_error_beacon_answers_through_the_full_router() {
    install_metrics_recorder().unwrap();
    let dist = std::env::temp_dir().join(format!("b01-dist-{}", std::process::id()));
    std::fs::create_dir_all(&dist).unwrap();
    std::fs::write(dist.join("index.html"), "<!doctype html>").unwrap();
    let service = "b01-full-router";
    let app = app(service, &dist);
    let response = app
        .oneshot(
            Request::post("/api/v1/client-errors")
                .header("content-type", "text/plain;charset=UTF-8")
                .body(Body::from(
                    r#"{"kind":"boot","build":"b01full","route":"/login"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    std::fs::remove_dir_all(&dist).unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert!(series(service, "/api/v1/client-errors", 204));
    assert!(
        install_metrics_recorder()
            .unwrap()
            .render()
            .contains("console_client_errors_total{kind=\"boot\",build=\"b01full\"} 1")
    );
}
