// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
#![allow(dead_code)]
use std::{
    collections::BTreeMap,
    num::NonZeroU64,
    sync::{Arc, Mutex},
};

use axum::{
    Router,
    extract::{OriginalUri, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use console_ops_adapter_http::{HttpAlertmanager, HttpReadLimits};
use serde_json::{Value, json};

type Replies = Arc<Mutex<BTreeMap<String, (StatusCode, HeaderMap, String)>>>;

pub struct Fixture {
    pub replies: Replies,
    pub task: tokio::task::JoinHandle<()>,
    pub source: HttpAlertmanager,
    pub url: String,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Fixture {
    pub async fn new() -> Self {
        let replies = Arc::new(Mutex::new(BTreeMap::new()));
        let app = Router::new()
            .fallback(
                |State(replies): State<Replies>, uri: OriginalUri| async move {
                    let reply = replies.lock().unwrap().get(uri.path()).cloned();
                    reply
                        .unwrap_or((
                            StatusCode::NOT_FOUND,
                            HeaderMap::new(),
                            "not a fixture route".into(),
                        ))
                        .into_response()
                },
            )
            .with_state(Arc::clone(&replies));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/monitoring/", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let fixture = Self {
            replies,
            task,
            source: HttpAlertmanager::new(&url, NonZeroU64::new(1).unwrap(), limits()).unwrap(),
            url,
        };
        fixture.set("alerts", json!([{
            "fingerprint": "fixture-fingerprint", "labels": {"alertname": "SyntheticAlert", "job": "console-1"},
            "annotations": {"summary": "Synthetic fixture alert"},
            "startsAt": "2026-01-01T00:00:00Z", "endsAt": "2026-01-01T01:00:00Z",
            "status": {"state": "active", "silencedBy": [], "inhibitedBy": []}
        }]));
        fixture.set("silences", json!([{
            "id": "fixture-silence", "matchers": [{"name": "job", "value": "console-1", "isRegex": false}],
            "startsAt": "2026-01-01T00:00:00Z", "endsAt": "2026-01-02T00:00:00Z", "createdBy": "fixture", "comment": "Synthetic silence"
        }]));
        fixture.set("status", json!({"versionInfo": {"version": "fixture"}, "uptime": "2026-01-01T00:00:00Z", "config": {"original": "must not enter the snapshot"}}));
        fixture
    }

    pub fn set(&self, path: &str, body: Value) {
        self.reply(path, StatusCode::OK, body.to_string());
    }
    pub fn reply(&self, path: &str, status: StatusCode, body: String) {
        self.replies.lock().unwrap().insert(
            format!("/monitoring/api/v2/{path}"),
            (status, HeaderMap::new(), body),
        );
    }
}

pub fn limits() -> HttpReadLimits {
    serde_json::from_value(json!({"request_timeout_ms": 500, "max_response_bytes": 4096})).unwrap()
}
