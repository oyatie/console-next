// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use std::{num::NonZeroU64, time::Duration};

use axum::http::StatusCode;
use console_ops_adapter_http::{HttpAlertmanager, HttpReadLimits};
use console_ops_application::{Alertmanager, SourceError};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

mod support;
use support::Fixture;

fn limits(timeout_ms: u64, bytes: usize) -> HttpReadLimits {
    serde_json::from_value(json!({"request_timeout_ms": timeout_ms, "max_response_bytes": bytes}))
        .unwrap()
}

#[tokio::test]
async fn configured_body_cap_accepts_the_boundary_and_rejects_known_and_chunked_overflow() {
    let fixture = Fixture::new().await;
    let source =
        HttpAlertmanager::new(&fixture.url, NonZeroU64::new(1).unwrap(), limits(500, 1024))
            .unwrap();
    for chunked in [false, true] {
        for (size, valid) in [(1024, true), (1025, false)] {
            fixture.reply(
                "alerts",
                StatusCode::OK,
                format!("[]{}", " ".repeat(size - 2)),
            );
            let mut server = None;
            let result = if chunked {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let chunked_source = HttpAlertmanager::new(
                    &format!("http://{}/monitoring/", listener.local_addr().unwrap()),
                    NonZeroU64::new(1).unwrap(),
                    limits(500, 1024),
                )
                .unwrap();
                let replies = fixture.replies.lock().unwrap().clone();
                server = Some(tokio::spawn(async move {
                    loop {
                        let (mut socket, _) = listener.accept().await.unwrap();
                        let mut request = [0; 4096];
                        let len = socket.read(&mut request).await.unwrap();
                        let request = std::str::from_utf8(&request[..len]).unwrap();
                        let path = request.split_whitespace().nth(1).unwrap();
                        let body = &replies[path].2;
                        socket.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").await.unwrap();
                        for chunk in body.as_bytes().chunks(300) {
                            socket
                                .write_all(format!("{:x}\r\n", chunk.len()).as_bytes())
                                .await
                                .unwrap();
                            socket.write_all(chunk).await.unwrap();
                            socket.write_all(b"\r\n").await.unwrap();
                        }
                        socket.write_all(b"0\r\n\r\n").await.unwrap();
                    }
                }));
                chunked_source.read().await
            } else {
                source.read().await
            };
            if let Some(server) = server {
                server.abort();
            }
            if valid {
                assert!(result.is_ok(), "{result:?}");
            } else {
                assert_eq!(result.unwrap_err(), SourceError::Invalid);
            }
        }
    }
}

#[test]
fn limits_are_required_positive_and_timeout_must_be_less_than_interval() {
    for config in [
        json!({}),
        json!({"request_timeout_ms":0,"max_response_bytes":1}),
        json!({"request_timeout_ms":1,"max_response_bytes":0}),
    ] {
        assert!(serde_json::from_value::<HttpReadLimits>(config).is_err());
    }
    for timeout_ms in [1000, 1001] {
        assert!(matches!(
            HttpAlertmanager::new(
                "http://example.invalid",
                NonZeroU64::new(1).unwrap(),
                limits(timeout_ms, 1024)
            ),
            Err(SourceError::Configuration)
        ));
    }
    assert!(
        HttpAlertmanager::new(
            "http://example.invalid",
            NonZeroU64::new(1).unwrap(),
            limits(999, 1024)
        )
        .is_ok()
    );
}

#[tokio::test]
async fn oversized_content_length_is_rejected_before_reading_a_stalled_body() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let source = HttpAlertmanager::new(
        &format!("http://{}", listener.local_addr().unwrap()),
        NonZeroU64::new(10).unwrap(),
        limits(5000, 1024),
    )
    .unwrap();
    let server = tokio::spawn(async move {
        let mut sockets = Vec::new();
        for _ in 0..3 {
            let (mut socket, _) = listener.accept().await.unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1025\r\n\r\n")
                .await
                .unwrap();
            sockets.push(socket);
        }
        std::future::pending::<()>().await;
        drop(sockets);
    });
    let result = tokio::time::timeout(Duration::from_secs(1), source.read()).await;
    server.abort();
    assert_eq!(result.unwrap().unwrap_err(), SourceError::Invalid);
}

#[tokio::test]
async fn configured_fractional_deadline_covers_a_body_that_never_finishes() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let source = HttpAlertmanager::new(
        &format!("http://{}", listener.local_addr().unwrap()),
        NonZeroU64::new(1).unwrap(),
        limits(50, 1024),
    )
    .unwrap();
    let server = tokio::spawn(async move {
        let mut sockets = Vec::new();
        for _ in 0..3 {
            let (mut socket, _) = listener.accept().await.unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n[")
                .await
                .unwrap();
            sockets.push(socket);
        }
        std::future::pending::<()>().await;
        drop(sockets);
    });
    let result = tokio::time::timeout(Duration::from_millis(500), source.read()).await;
    server.abort();
    assert_eq!(result.unwrap().unwrap_err(), SourceError::Down);
}
