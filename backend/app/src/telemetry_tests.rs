// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]

use super::*;
use opentelemetry::{Key, Value};
use opentelemetry_sdk::error::OTelSdkResult;
use opentelemetry_sdk::trace::{SpanData, SpanExporter};
use std::sync::{Arc, Mutex};
use tracing::instrument::WithSubscriber;

#[derive(Clone, Debug, Default)]
struct RecordingExporter {
    spans: Arc<Mutex<Vec<SpanData>>>,
    resource: Arc<Mutex<Option<Resource>>>,
}

impl SpanExporter for RecordingExporter {
    async fn export(&self, batch: Vec<SpanData>) -> OTelSdkResult {
        self.spans.lock().unwrap().extend(batch);
        Ok(())
    }

    fn set_resource(&mut self, resource: &Resource) {
        *self.resource.lock().unwrap() = Some(resource.clone());
    }
}

#[tokio::test]
async fn exported_request_preserves_service_fields_events_and_trace_correlation() {
    use axum::{Json, Router, body::Body, http::Request, routing::get};
    use tower::ServiceExt;

    let config = AppConfig::from_pairs([("OTEL_SERVICE_NAME", "telemetry-test")]).unwrap();
    let exporter = RecordingExporter::default();
    let provider = tracer_provider(&config, exporter.clone());
    let subscriber = tracing_subscriber::registry().with(
        tracing_opentelemetry::layer().with_tracer(provider.tracer(config.service_name.clone())),
    );
    let response = async {
        Router::new()
            .route(
                "/people/{id}",
                get(|| async {
                    let context = current_trace_context();
                    let child = tracing::info_span!("handler").in_scope(current_trace_context);
                    Json(serde_json::json!({
                        "trace_id": context.trace_id(),
                        "span_id": context.span_id(),
                        "child_trace_id": child.trace_id(),
                        "child_span_id": child.span_id(),
                    }))
                }),
            )
            .layer(crate::http::trace::http_trace_layer())
            .oneshot(
                Request::builder()
                    .uri("/people/private-person?search=private-query")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
    }
    .with_subscriber(subscriber)
    .await;
    let body: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    TelemetryGuard {
        provider: Some(provider),
    }
    .shutdown();

    let resource = exporter.resource.lock().unwrap();
    assert_eq!(
        resource.as_ref().unwrap().get(&Key::from("service.name")),
        Some(Value::from(config.service_name.clone()))
    );
    let spans = exporter.spans.lock().unwrap();
    assert_eq!(spans.len(), 2);
    let request = spans.iter().find(|s| s.name == "http.request").unwrap();
    let child = spans.iter().find(|s| s.name == "handler").unwrap();
    assert_eq!(request.instrumentation_scope.name(), config.service_name);
    assert_eq!(
        request.span_context.trace_id().to_string(),
        body["trace_id"]
    );
    assert_eq!(request.span_context.span_id().to_string(), body["span_id"]);
    assert_eq!(child.span_context.trace_id().to_string(), body["trace_id"]);
    assert_eq!(body["child_trace_id"], body["trace_id"]);
    assert_eq!(child.parent_span_id, request.span_context.span_id());
    assert_eq!(
        child.span_context.span_id().to_string(),
        body["child_span_id"]
    );
    for (key, expected) in [
        ("method", "GET"),
        ("http_route", "/people/{id}"),
        ("version", "HTTP/1.1"),
        ("trace_id", body["trace_id"].as_str().unwrap()),
        ("span_id", body["span_id"].as_str().unwrap()),
    ] {
        assert!(
            request
                .attributes
                .contains(&opentelemetry::KeyValue::new(key, expected.to_owned(),))
        );
    }
    assert_eq!(request.events.len(), 2);
    assert_eq!(request.events[0].name, "http request started");
    assert_eq!(request.events[1].name, "http request completed");
    assert!(
        request.events[1]
            .attributes
            .contains(&opentelemetry::KeyValue::new("status", "200"))
    );
    for event in request.events.iter() {
        assert!(event.attributes.contains(&opentelemetry::KeyValue::new(
            "trace_id",
            body["trace_id"].as_str().unwrap().to_owned(),
        )));
    }
    let exported = format!("{spans:?}");
    assert!(!exported.contains("private-person"));
    assert!(!exported.contains("private-query"));
}

#[tokio::test]
async fn without_an_exporter_request_trace_context_is_reused() {
    let context = TraceContext::generate();
    REQUEST_TRACE
        .scope(context.clone(), async {
            let actual = current_trace_context();
            assert_eq!(actual.trace_id(), context.trace_id());
            assert_eq!(actual.span_id(), context.span_id());
            assert_eq!(record_otel_ids(&tracing::Span::none()), context.trace_id());
        })
        .with_subscriber(tracing::subscriber::NoSubscriber::default())
        .await;
}
