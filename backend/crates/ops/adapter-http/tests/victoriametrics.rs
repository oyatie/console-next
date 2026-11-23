// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::BTreeMap;
use std::num::NonZeroU64;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::extract::{OriginalUri, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use console_ops_adapter_http::{HttpJwksFetcher, HttpReadLimits, HttpVictoriaMetrics};
use console_ops_application::{SourceError, TargetHealth, VictoriaMetrics};
use serde_json::{Value, json};

type Replies = Arc<Mutex<BTreeMap<String, (StatusCode, HeaderMap, String)>>>;
type TestResult = Result<(), Box<dyn std::error::Error>>;

struct VmFixture {
    replies: Replies,
    queries_seen: Arc<Mutex<Vec<String>>>,
    task: tokio::task::JoinHandle<()>,
    source: HttpVictoriaMetrics,
    url: String,
}

impl Drop for VmFixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl VmFixture {
    async fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let replies: Replies = Arc::new(Mutex::new(BTreeMap::new()));
        let queries_seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let r = Arc::clone(&replies);
        let q = Arc::clone(&queries_seen);
        let app = Router::new()
            .fallback(
                |State((replies, seen)): State<(Replies, Arc<Mutex<Vec<String>>>)>,
                 uri: OriginalUri| async move {
                    if let Some(query) = uri.query() {
                        seen.lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .push(query.to_owned());
                    }
                    let reply = replies
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .get(uri.path())
                        .cloned();
                    reply
                        .unwrap_or((
                            StatusCode::NOT_FOUND,
                            HeaderMap::new(),
                            "not a fixture route".into(),
                        ))
                        .into_response()
                },
            )
            .with_state((r, q));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("http://{}/vm/", listener.local_addr()?);
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let limits: HttpReadLimits =
            serde_json::from_value(json!({"request_timeout_ms": 500, "max_response_bytes": 4096}))?;
        let interval = NonZeroU64::new(1).ok_or("nonzero")?;
        let source = HttpVictoriaMetrics::new(&url, interval, limits)?;
        Ok(Self {
            replies,
            queries_seen,
            task,
            source,
            url,
        })
    }

    fn set(&self, path: &str, status: StatusCode, body: Value) {
        self.replies
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(
                format!("/vm/api/v1/{path}"),
                (status, HeaderMap::new(), body.to_string()),
            );
    }
}

#[tokio::test]
async fn queries_instant_vectors_and_targets_with_url_encoding() -> TestResult {
    let fixture = VmFixture::new().await?;
    fixture.set(
        "query",
        StatusCode::OK,
        json!({
            "status": "success",
            "data": {
                "resultType": "vector",
                "result": [
                    {"metric": {"__name__": "up", "job": "ops"}, "value": [1767225600.0, "1"]}
                ]
            }
        }),
    );
    fixture.set(
        "targets",
        StatusCode::OK,
        json!({
            "status": "success",
            "data": {
                "activeTargets": [
                    {
                        "labels": {"job": "ops"},
                        "scrapePool": "ops",
                        "health": "up",
                        "lastError": "",
                        "lastScrape": "2026-01-01T00:00:00Z"
                    },
                    {
                        "labels": {"job": "down-svc"},
                        "scrapePool": "down-svc",
                        "health": "down",
                        "lastError": "connection refused",
                        "lastScrape": "0001-01-01T00:00:00Z"
                    }
                ]
            }
        }),
    );

    let samples = fixture
        .source
        .query_instant("slo:error_budget:ratio")
        .await?;
    assert_eq!(samples.len(), 1);
    assert_eq!(samples[0].metric["job"], "ops");
    assert!((samples[0].value - 1.0).abs() < f64::EPSILON);

    let targets = fixture.source.targets().await?;
    assert_eq!(targets.len(), 2);
    assert_eq!(targets[0].health, TargetHealth::Up);
    assert!(targets[0].last_scrape.is_some());
    assert_eq!(targets[1].health, TargetHealth::Down);
    assert!(targets[1].last_scrape.is_none());

    let seen = fixture
        .queries_seen
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    assert!(seen.iter().any(|q| q == "query=slo%3Aerror_budget%3Aratio"));
    Ok(())
}

#[tokio::test]
async fn fails_closed_on_503_redirect_malformed_and_oversized_responses() -> TestResult {
    let fixture = VmFixture::new().await?;

    fixture.set("query", StatusCode::SERVICE_UNAVAILABLE, json!({}));
    assert_eq!(
        fixture.source.query_instant("up").await,
        Err(SourceError::Down)
    );

    fixture.set("query", StatusCode::FOUND, json!({}));
    assert_eq!(
        fixture.source.query_instant("up").await,
        Err(SourceError::Down)
    );

    for bad in [
        json!({"status": "error", "data": {"resultType": "vector", "result": []}}),
        json!({"status": "success", "data": {"resultType": "matrix", "result": []}}),
        json!({"status": "success", "data": {"resultType": "vector", "result": [{"metric": {}, "value": [1767225600.0, "NaN"]}]}}),
        json!({"status": "success", "data": {"resultType": "vector", "result": [{"metric": {}, "value": [1767225600.0, "abc"]}]}}),
    ] {
        fixture.set("query", StatusCode::OK, bad);
        assert_eq!(
            fixture.source.query_instant("up").await,
            Err(SourceError::Invalid)
        );
    }

    fixture.set(
        "targets",
        StatusCode::OK,
        json!({"status": "success", "data": {"activeTargets": [{"health": "invented"}]}}),
    );
    assert_eq!(fixture.source.targets().await, Err(SourceError::Invalid));

    let tiny: HttpReadLimits =
        serde_json::from_value(json!({"request_timeout_ms": 500, "max_response_bytes": 16}))?;
    let interval = NonZeroU64::new(1).ok_or("nonzero")?;
    let small = HttpVictoriaMetrics::new(&fixture.url, interval, tiny)?;
    fixture.set(
        "query",
        StatusCode::OK,
        json!({"status": "success", "data": {"resultType": "vector", "result": []}}),
    );
    assert_eq!(small.query_instant("up").await, Err(SourceError::Invalid));
    Ok(())
}

#[tokio::test]
async fn jwks_fetcher_uses_exact_url_and_bounded_reads() -> TestResult {
    let fixture = VmFixture::new().await?;
    fixture
        .replies
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(
            "/vm/certs".to_owned(),
            (
                StatusCode::OK,
                HeaderMap::new(),
                r#"{"keys":[]}"#.to_owned(),
            ),
        );
    let limits: HttpReadLimits =
        serde_json::from_value(json!({"request_timeout_ms": 500, "max_response_bytes": 4096}))?;
    let interval = NonZeroU64::new(1).ok_or("nonzero")?;
    let fetcher = HttpJwksFetcher::new(&format!("{}certs", fixture.url), interval, limits)?;
    assert_eq!(fetcher.fetch_text().await?, r#"{"keys":[]}"#);

    let tiny: HttpReadLimits =
        serde_json::from_value(json!({"request_timeout_ms": 500, "max_response_bytes": 4}))?;
    let small = HttpJwksFetcher::new(&format!("{}certs", fixture.url), interval, tiny)?;
    assert_eq!(small.fetch_text().await, Err(SourceError::Invalid));
    Ok(())
}
