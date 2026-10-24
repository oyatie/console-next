//! `GET /api/v1/events`: the server-sent-events stream over the hub, for
//! one-way server → client traffic (decisions #27; contract in
//! `scratchpad/rt/contract.md`).
//!
//! INTEG merges [`router`] outside the 30 s `TimeoutLayer`, like the WS route.
//! The body ends (no frame) on any hub disconnect notice — `ServerShutdown`
//! included, so a rollout does not wait the drain — at the bearer's `exp`,
//! and when the session recheck finds the principal changed. The client
//! reconnects with `Last-Event-ID` (the last `seq`) and loses nothing.

mod lease;

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use crate::ChangeReader;
use axum::Router;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use console_platform_authz::Principal;
use futures::StreamExt;
use tokio::sync::mpsc;
use tokio::time::Instant;

use self::lease::{Lease, StreamCounts};
use crate::auth::{RealtimeApiError, TOKEN_EXPIRED, authorization_bearer_token, reader_from_token};
use crate::deliver::{Recheck, prepare};
use crate::{DisconnectNotice, RealtimeEvent, RealtimeRestState, SOCKET_IO_TIMEOUT, StreamFrom};

pub const EVENTS_ROUTE_PATHS: &[&str] = &["/api/v1/events"];

const LAST_EVENT_ID: HeaderName = HeaderName::from_static("last-event-id");
const X_ACCEL_BUFFERING: HeaderName = HeaderName::from_static("x-accel-buffering");

/// Stream tunables. Each field is the spec §9 key it names; INTEG fills them
/// from the settings registry (SET-RT), `Default` is the code default.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseConfig {
    /// `realtime.max_streams_per_user`: one more stream gets 429.
    pub max_streams_per_user: usize,
}

impl Default for SseConfig {
    fn default() -> Self {
        Self {
            max_streams_per_user: 10,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SseState {
    rest: RealtimeRestState,
    config: SseConfig,
    streams: StreamCounts,
}

impl SseState {
    #[must_use]
    pub fn new(rest: RealtimeRestState, config: SseConfig) -> Self {
        Self {
            rest,
            config,
            streams: StreamCounts::default(),
        }
    }

    /// The stream as the handler opens it after bearer resolution, for crate
    /// tests without a database (like `PgRealtimeHub::dispatch_local_for_test`).
    #[doc(hidden)]
    pub async fn stream_for_test(
        &self,
        reader: Principal,
        deadline: Instant,
        from: StreamFrom,
    ) -> Response {
        open_stream(self, reader.into(), String::new(), deadline, from)
            .await
            .unwrap_or_else(IntoResponse::into_response)
    }
}

pub fn router(state: SseState) -> Router {
    Router::new()
        .route(EVENTS_ROUTE_PATHS[0], get(events_handler))
        .with_state(state)
}

async fn events_handler(
    State(state): State<SseState>,
    headers: HeaderMap,
) -> Result<Response, RealtimeApiError> {
    let verifier = state
        .rest
        .jwt_verifier
        .as_ref()
        .ok_or_else(RealtimeApiError::unavailable)?;
    let token = authorization_bearer_token(&headers)?
        .ok_or_else(|| RealtimeApiError::unauthorized("missing bearer token"))?
        .to_owned();
    // An expired access token is the expected end of every stream (it closes at `exp`): its own code, so a client
    // renews and an SLI does not count it as a refusal.
    let claims = verifier.verify_access_token(&token).map_err(|e| {
        if e.is_expired() {
            RealtimeApiError::new(
                StatusCode::UNAUTHORIZED,
                TOKEN_EXPIRED,
                "access token expired",
            )
        } else {
            RealtimeApiError::unauthorized("invalid bearer token")
        }
    })?;
    let reader = reader_from_token(&state.rest, &token).await?;
    crate::auth::require_consent(&state.rest, &token).await?;
    let expires_at = time::OffsetDateTime::from_unix_timestamp(claims.exp)
        .map_err(|_| RealtimeApiError::unauthorized("invalid access deadline"))?;
    let remaining =
        Duration::try_from(expires_at - time::OffsetDateTime::now_utc()).unwrap_or(Duration::ZERO);
    let from = StreamFrom {
        last_message_id: None,
        last_event_id: last_event_id(&headers),
    };
    open_stream(&state, reader, token, Instant::now() + remaining, from).await
}

/// The last `seq` the client saw. Anything else opens the stream live.
fn last_event_id(headers: &HeaderMap) -> Option<i64> {
    let value = headers.get(LAST_EVENT_ID)?.to_str().ok()?;
    value.trim().parse::<i64>().ok().filter(|seq| *seq >= 0)
}

async fn open_stream(
    state: &SseState,
    reader: ChangeReader,
    token: String,
    deadline: Instant,
    from: StreamFrom,
) -> Result<Response, RealtimeApiError> {
    let mut lease = Lease::acquire(state, &reader)?;
    let reader = Arc::new(reader);
    let (connection_id, events_rx, disconnect_rx) = state
        .rest
        .hub
        .connect_stream((*reader).clone(), from)
        .await
        .into_parts();
    lease.connection = Some(connection_id);
    let live = Live {
        rest: state.rest.clone(),
        reader,
        token,
        deadline,
        recheck: Recheck::new(state.rest.session_recheck_interval),
        events_rx,
        disconnect_rx,
        _lease: lease,
    };
    let retry = Event::default().retry(state.rest.hub.config.retry_hint);
    let frames = futures::stream::once(async move { Ok(retry) })
        .chain(futures::stream::unfold(live, next_frame));
    let mut response = Sse::new(frames)
        .keep_alive(KeepAlive::new().interval(state.rest.heartbeat_interval))
        .into_response();
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(X_ACCEL_BUFFERING, HeaderValue::from_static("no"));
    Ok(response)
}

/// Everything one open stream owns; dropping it (end or client gone) frees
/// the per-user count and the hub slot.
struct Live {
    rest: RealtimeRestState,
    reader: Arc<ChangeReader>,
    token: String,
    deadline: Instant,
    recheck: Recheck,
    events_rx: mpsc::Receiver<RealtimeEvent>,
    disconnect_rx: mpsc::UnboundedReceiver<DisconnectNotice>,
    _lease: Lease,
}

async fn next_frame(mut live: Live) -> Option<(Result<Event, Infallible>, Live)> {
    let hint = tokio::select! {
        biased;
        _ = live.disconnect_rx.recv() => return None,
        () = tokio::time::sleep_until(live.deadline) => return None,
        hint = live.events_rx.recv() => hint?,
    };
    let event = tokio::select! {
        biased;
        _ = live.disconnect_rx.recv() => return None,
        () = tokio::time::sleep_until(live.deadline) => return None,
        result = tokio::time::timeout(
            SOCKET_IO_TIMEOUT,
            prepare(&live.rest, &live.token, &live.reader, &mut live.recheck, hint),
        ) => result.ok()?.ok()?,
    };
    Some((Ok(frame(&event)?), live))
}

/// The SSE wire form of one event (`contract.md`).
pub(crate) fn frame(event: &RealtimeEvent) -> Option<Event> {
    let frame = Event::default();
    match event {
        RealtimeEvent::PrivacyConsent { accepted } => frame
            .event("privacy_consent")
            .json_data(serde_json::json!({"accepted": accepted})),
        RealtimeEvent::Hello { id, data } => frame.event("hello").id(id).json_data(data),
        RealtimeEvent::Change { id, data } => frame.event("change").id(id).json_data(data),
        RealtimeEvent::Reset { data } => frame.event("reset").json_data(data),
        RealtimeEvent::MessagePosted { .. } => frame.event("message_posted").json_data(event),
        RealtimeEvent::MessageAcked { .. } => frame.event("message_acked").json_data(event),
        RealtimeEvent::NotificationCreated { .. } => {
            frame.event("notification_created").json_data(event)
        }
    }
    .ok()
}
