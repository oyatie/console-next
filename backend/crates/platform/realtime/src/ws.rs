//! `/api/v1/ws`: the WebSocket transport over the hub, for two-way,
//! latency-sensitive traffic (messenger today; presence, claims and
//! collaborative editing when they ship). It carries the same Cedar-filtered
//! change frames as SSE (`deliver.rs`), so React Native can fall back to it.

use std::time::Duration;

use axum::Router;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use console_kernel_core::MessageId;
use console_platform_authz::Principal;
use serde::Deserialize;

use crate::auth::{RealtimeApiError, bearer_token, reader_from_token};
use crate::deliver::{Recheck, prepare};
use crate::{
    DisconnectNotice, DisconnectReason, RealtimePrincipal, RealtimeRestState, SOCKET_IO_TIMEOUT,
    StreamFrom,
};

/// `any()`, not `get()`: whether Cloudflare reaches the origin with an
/// HTTP/1.1 Upgrade or an HTTP/2 extended CONNECT is unknown
/// (`infra/realtime-transports.md` §6), and axum 0.8 serves WS over h2 only
/// on an `any` route.
pub fn router(state: RealtimeRestState) -> Router {
    Router::new()
        .route(crate::WS_ROUTE_PATHS[0], any(websocket_handler))
        .with_state(state)
}

#[derive(Debug, Deserialize)]
struct WsQuery {
    last_message_id: Option<MessageId>,
    /// `changes=true` subscribes this socket to the change stream too
    /// (`hello`/`change`/`reset`, as SSE sends them). Off by default, so a
    /// messenger-only client sees exactly the frames it always did.
    #[serde(default)]
    changes: bool,
    /// The change stream's `seq` cursor, as SSE's `Last-Event-ID`.
    last_event_id: Option<i64>,
}

async fn websocket_handler(
    State(state): State<RealtimeRestState>,
    headers: HeaderMap,
    Query(query): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> Result<Response, RealtimeApiError> {
    let verifier = state
        .jwt_verifier
        .as_ref()
        .ok_or_else(RealtimeApiError::unavailable)?;
    let token = bearer_token(&headers)?.to_owned();
    let reader = reader_from_token(&state, &token).await?;
    let claims = verifier
        .verify_access_token(&token)
        .map_err(|_| RealtimeApiError::unauthorized("invalid bearer token"))?;
    let expires_at = time::OffsetDateTime::from_unix_timestamp(claims.exp)
        .map_err(|_| RealtimeApiError::unauthorized("invalid access deadline"))?;
    let remaining =
        Duration::try_from(expires_at - time::OffsetDateTime::now_utc()).unwrap_or(Duration::ZERO);
    let deadline = tokio::time::Instant::now() + remaining;
    let from = StreamFrom {
        last_message_id: query.last_message_id,
        last_event_id: query.last_event_id.filter(|seq| *seq >= 0),
    };
    let changes = query.changes;
    Ok(ws
        // Browser clients carry the bearer token as a `Sec-WebSocket-Protocol`
        // subprotocol pair (`bearer, <token>`); the WebSocket handshake REQUIRES
        // the server to echo one offered subprotocol, so select `bearer` to
        // complete the handshake (without this the browser aborts with "Sent
        // non-empty 'Sec-WebSocket-Protocol' header but no response was received").
        .protocols(["bearer"])
        .on_upgrade(move |socket| {
            websocket_session(state, reader, token, deadline, (changes, from), socket)
        })
        .into_response())
}

async fn websocket_session(
    state: RealtimeRestState,
    reader: Principal,
    token: String,
    deadline: tokio::time::Instant,
    (changes, from): (bool, StreamFrom),
    mut socket: WebSocket,
) {
    let connection = if changes {
        state.hub.connect_stream(reader.clone(), from).await
    } else {
        let principal = RealtimePrincipal {
            user_id: reader.user_id,
            branch_scope: reader.branch_scope.clone(),
            org_id: reader.org_id,
        };
        match state.hub.connect(principal, from.last_message_id).await {
            Ok(connection) => connection,
            Err(_) => {
                send_close(&mut socket, (1011, "realtime unavailable".into())).await;
                return;
            }
        }
    };
    let (connection_id, mut events_rx, mut disconnect_rx) = connection.into_parts();
    let mut recheck = Recheck::new(state.session_recheck_interval);
    // Server ping: Cloudflare's WS idle cutoff is undocumented, so keep the
    // socket busy at the stream heartbeat (`infra/realtime-transports.md` §2).
    let mut ping = tokio::time::interval_at(
        tokio::time::Instant::now() + state.heartbeat_interval,
        state.heartbeat_interval,
    );

    let close = loop {
        tokio::select! {
            biased;
            notice = disconnect_rx.recv() => {
                break notice.as_ref().map(close_frame_for_notice);
            }
            _ = tokio::time::sleep_until(deadline) => {
                break Some((1008, "realtime access denied".into()));
            }
            _ = ping.tick() => {
                let sent = tokio::time::timeout(
                    SOCKET_IO_TIMEOUT,
                    socket.send(Message::Ping(Vec::new().into())),
                )
                .await;
                if !matches!(sent, Ok(Ok(()))) { break None; }
            }
            event = events_rx.recv() => {
                let Some(event) = event else { break None; };
                let prepared = tokio::select! {
                    biased;
                    notice = disconnect_rx.recv() => {
                        break notice.as_ref().map(close_frame_for_notice);
                    }
                    _ = tokio::time::sleep_until(deadline) => {
                        break Some((1008, "realtime access denied".into()));
                    }
                    result = tokio::time::timeout(
                        SOCKET_IO_TIMEOUT,
                        prepare(&state, &token, &reader, &mut recheck, event),
                    ) => {
                        result.unwrap_or_else(|_| Err(RealtimeApiError::unavailable()))
                    }
                };
                let event = match prepared {
                    Ok(event) => event,
                    Err(err) => {
                        break Some(if err.status.is_server_error() {
                            (1011, "realtime unavailable".into())
                        } else {
                            (1008, "realtime access denied".into())
                        });
                    }
                };
                let Ok(json) = serde_json::to_string(&event) else {
                    break Some((1011, "realtime unavailable".into()));
                };
                // An interrupted Text write may already be buffered by the transport.
                // Drop it: sending Close afterward could flush that data. Already
                // handed-off bytes cannot be recalled; timeout is not non-delivery.
                let sent = tokio::select! {
                    biased;
                    _ = disconnect_rx.recv() => break None,
                    _ = tokio::time::sleep_until(deadline) => break None,
                    result = tokio::time::timeout(SOCKET_IO_TIMEOUT, socket.send(Message::Text(json.into()))) => result,
                };
                if !matches!(sent, Ok(Ok(()))) { break None; }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break None,
                    Some(Ok(_)) => {}
                }
            }
        }
    };

    state.hub.remove_connection(connection_id).await;
    if let Some(close) = close {
        send_close(&mut socket, close).await;
    }
}

async fn send_close(socket: &mut WebSocket, (code, reason): (u16, String)) {
    let _ = tokio::time::timeout(
        SOCKET_IO_TIMEOUT,
        socket.send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        }))),
    )
    .await;
}

fn close_frame_for_notice(notice: &DisconnectNotice) -> (u16, String) {
    match notice.reason {
        DisconnectReason::LaggingConsumer => (
            1013,
            "lagging_consumer; reconnect with last_message_id cursor".to_owned(),
        ),
        DisconnectReason::ReplayFailed => (
            1011,
            "replay_failed; reconnect with last_message_id cursor".to_owned(),
        ),
        DisconnectReason::ServerShutdown => (1001, "server_shutdown".to_owned()),
    }
}
