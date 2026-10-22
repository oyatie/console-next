// SPDX-License-Identifier: LicenseRef-Proprietary
//! A VictoriaLogs HTTP fixture fed by the real request's structured log output.
use axum::{
    Router,
    extract::{Query, State},
    routing::get,
};
use serde_json::Value;
use std::{
    collections::HashMap,
    io,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

#[derive(Clone, Default)]
pub struct Logs(pub Arc<Mutex<Vec<u8>>>);
impl io::Write for Logs {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
pub struct Store {
    pub endpoint: String,
    pub logs: Logs,
    pub reads: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}
impl Store {
    pub async fn start() -> Self {
        let logs = Logs::default();
        let reads = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!(
            "http://{}/select/logsql/query",
            listener.local_addr().unwrap()
        );
        let router = Router::new()
            .route("/select/logsql/query", get(query))
            .with_state((logs.clone(), reads.clone()));
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        Self {
            endpoint,
            logs,
            reads,
            task,
        }
    }
    pub fn subscriber(&self) -> impl tracing::Subscriber + Send + Sync + 'static {
        let logs = self.logs.clone();
        tracing_subscriber::fmt()
            .json()
            .with_writer(move || logs.clone())
            .finish()
    }
}
impl Drop for Store {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn query(
    State((logs, reads)): State<(Logs, Arc<AtomicUsize>)>,
    Query(args): Query<HashMap<String, String>>,
) -> String {
    reads.fetch_add(1, Ordering::Relaxed);
    assert_eq!(args.get("limit").unwrap(), "1");
    let raw = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
    for line in raw.lines() {
        let event: Value = serde_json::from_str(line).unwrap();
        let fields = &event["fields"];
        let Some(reference) = fields["support_ref"].as_str() else {
            continue;
        };
        if fields["message"] == "support reference"
            && args["query"].starts_with(&format!("fields.support_ref:=\"{reference}\" | fields "))
        {
            let mut projected = serde_json::json!({});
            for key in [
                "support_ref",
                "trace_id",
                "release",
                "route_template",
                "org_id",
                "support_ref_at",
            ] {
                projected[format!("fields.{key}")] = fields[key].clone();
            }
            return projected.to_string() + "\n";
        }
    }
    String::new()
}
