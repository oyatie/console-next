// SPDX-License-Identifier: LicenseRef-Proprietary
use std::num::NonZeroU64;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::extract::{OriginalUri, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::IntoResponse;
use console_ops_adapter_http::HttpStatusFeed;
use console_ops_application::SourceError;
use console_ops_application::alert_actions::{AlertmanagerSilencePost, AlertmanagerWriter};
use console_ops_application::health::StatusFeed;
use console_ops_domain::UtcTimestamp;
use console_ops_domain::alert_actions::SilenceMatcherInput;
use serde_json::json;
use time::macros::datetime;

mod support;
use support::{Fixture, limits};

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[tokio::test]
async fn alertmanager_writer_creates_and_deletes_silences_and_rejects_bad_ids() -> TestResult {
    let fixture = Fixture::new().await;
    fixture.set("silences", json!({"silenceID": "sil-123"}));

    let post = AlertmanagerSilencePost {
        matchers: vec![SilenceMatcherInput {
            name: "alertname".into(),
            value: "HighLatency".into(),
            is_regex: false,
            is_equal: true,
        }],
        starts_at: UtcTimestamp::new(datetime!(2026-11-20 00:00 UTC)),
        ends_at: UtcTimestamp::new(datetime!(2026-11-20 02:00 UTC)),
        created_by: "op-1".into(),
        comment: "Investigating spike in latency".into(),
    };
    let id = fixture.source.create_silence(&post).await?;
    assert_eq!(id, "sil-123");

    fixture.set("silence/sil-123", json!({"status": "deleted"}));
    fixture.source.delete_silence("sil-123").await?;

    assert_eq!(
        fixture.source.delete_silence("../bad").await,
        Err(SourceError::Invalid)
    );

    fixture.reply("silences", StatusCode::SERVICE_UNAVAILABLE, "down".into());
    assert_eq!(
        fixture.source.create_silence(&post).await,
        Err(SourceError::Down)
    );
    Ok(())
}

#[tokio::test]
async fn http_status_feed_parses_v2_and_fails_closed_on_invalid_or_redirect() -> TestResult {
    let body = Arc::new(Mutex::new((
        StatusCode::OK,
        HeaderMap::new(),
        json!({
            "schema": 2,
            "rev": 5,
            "generated_at": "2026-11-20T00:00:00Z",
            "record_start": "2026-10-01T00:00:00Z",
            "evidence": {
                "schema": 1,
                "samples": [{
                    "at": "2026-11-20T00:00:00Z",
                    "components": {"web": "ok", "api": "ok"}
                }]
            },
            "incidents": [],
            "maintenances": []
        })
        .to_string(),
    )));
    let state = Arc::clone(&body);
    let app = Router::new()
        .fallback(
            |State(st): State<Arc<Mutex<(StatusCode, HeaderMap, String)>>>,
             _method: Method,
             _uri: OriginalUri| async move {
                let guard = st.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                guard.clone().into_response()
            },
        )
        .with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/status.json", listener.local_addr()?);
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let feed = HttpStatusFeed::new(&url, NonZeroU64::new(1).ok_or("nonzero")?, limits())?;
    let snap = feed.read().await?;
    assert_eq!(snap.rev, 5);

    {
        let mut guard = body
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.2 = json!({"schema": 1}).to_string();
    }
    assert_eq!(feed.read().await, Err(SourceError::Invalid));

    {
        let mut guard = body
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.0 = StatusCode::FOUND;
        guard.2 = "{}".to_owned();
    }
    assert_eq!(feed.read().await, Err(SourceError::Down));

    task.abort();
    Ok(())
}
