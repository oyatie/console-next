// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::VecDeque;
use std::convert::Infallible;
use std::time::Duration;

use axum::extract::State;
use axum::http::{HeaderMap, HeaderName, HeaderValue, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use console_ops_application::events::{OpsEvent, ReplayOutcome};
use tokio::sync::{broadcast, watch};
use tokio::time::{Instant, Interval, MissedTickBehavior, interval_at};

use crate::error::OpsApiError;
use crate::state::OpsRestState;

const LAST_EVENT_ID: HeaderName = HeaderName::from_static("last-event-id");
const X_ACCEL_BUFFERING: HeaderName = HeaderName::from_static("x-accel-buffering");
const HEARTBEAT_SECS: u64 = 15;

struct ClientGuard;

impl ClientGuard {
    fn acquire() -> Self {
        metrics::gauge!("ops_cockpit_sse_clients").increment(1.0);
        Self
    }
}

impl Drop for ClientGuard {
    fn drop(&mut self) {
        metrics::gauge!("ops_cockpit_sse_clients").decrement(1.0);
    }
}

fn parse_last_event_id(headers: &HeaderMap) -> Option<u64> {
    let raw = headers.get(&LAST_EVENT_ID)?.to_str().ok()?.trim();
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return Some(u64::MAX);
    }
    Some(raw.parse::<u64>().unwrap_or(u64::MAX))
}

struct LiveStream {
    state: OpsRestState,
    operator_email: String,
    pending: VecDeque<OpsEvent>,
    rx: broadcast::Receiver<OpsEvent>,
    shutdown: watch::Receiver<bool>,
    heartbeat: Interval,
    last_sent_id: u64,
    _guard: ClientGuard,
}

pub async fn get_events(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
) -> Result<Response, OpsApiError> {
    let op = state.authorize(&headers, "read.home", "/api/ops/v1/events")?;
    let last_event_id = parse_last_event_id(&headers);
    let rx = state.tx.subscribe();
    let mut pending = VecDeque::new();
    let mut last_sent_id = last_event_id.unwrap_or(0);

    let replay = {
        let store = state.snapshots.read().await;
        store.ring.replay_since(last_event_id)
    };
    match replay {
        ReplayOutcome::Current => {}
        ReplayOutcome::Resync => {
            metrics::counter!("ops_cockpit_sse_resyncs_total").increment(1);
            let resync_id = state.snapshots.write().await.ring.alloc_ephemeral_id();
            last_sent_id = resync_id;
            pending.push_back(OpsEvent::Resync {
                id: resync_id,
                evaluated_at: (state.clock)(),
            });
        }
        ReplayOutcome::Events(events) => {
            let now = (state.clock)();
            for ev in events {
                if ev.id() > last_sent_id {
                    last_sent_id = ev.id();
                }
                if state.is_action_allowed(&op.display_email, ev.required_action(), now) {
                    pending.push_back(ev);
                }
            }
        }
    }

    let period = Duration::from_secs(HEARTBEAT_SECS);
    let mut heartbeat = interval_at(Instant::now() + period, period);
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);

    let live = LiveStream {
        state: state.clone(),
        operator_email: op.display_email,
        pending,
        rx,
        shutdown: state.shutdown.clone(),
        heartbeat,
        last_sent_id,
        _guard: ClientGuard::acquire(),
    };

    let stream = futures::stream::unfold(live, next_frame);
    let mut response = Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(period))
        .into_response();
    let resp_headers = response.headers_mut();
    resp_headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    resp_headers.insert(X_ACCEL_BUFFERING, HeaderValue::from_static("no"));
    Ok(response)
}

async fn next_frame(mut live: LiveStream) -> Option<(Result<Event, Infallible>, LiveStream)> {
    loop {
        if let Some(ev) = live.pending.pop_front() {
            if let Some(frame) = encode_event(&ev) {
                return Some((Ok(frame), live));
            }
            continue;
        }
        if *live.shutdown.borrow() {
            return None;
        }
        tokio::select! {
            biased;
            changed = live.shutdown.changed() => {
                if changed.is_err() || *live.shutdown.borrow() {
                    return None;
                }
            }
            _ = live.heartbeat.tick() => {
                let id = live.state.snapshots.write().await.ring.alloc_ephemeral_id();
                live.last_sent_id = id;
                let hb = OpsEvent::Heartbeat {
                    id,
                    evaluated_at: (live.state.clock)(),
                };
                if let Some(frame) = encode_event(&hb) {
                    return Some((Ok(frame), live));
                }
            }
            msg = live.rx.recv() => {
                match msg {
                    Ok(ev) => {
                        if ev.id() <= live.last_sent_id {
                            continue;
                        }
                        live.last_sent_id = ev.id();
                        let now = (live.state.clock)();
                        if live.state.is_action_allowed(&live.operator_email, ev.required_action(), now)
                            && let Some(frame) = encode_event(&ev)
                        {
                            return Some((Ok(frame), live));
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        metrics::counter!("ops_cockpit_sse_resyncs_total").increment(1);
                        let id = live.state.snapshots.write().await.ring.alloc_ephemeral_id();
                        live.last_sent_id = id;
                        let resync = OpsEvent::Resync {
                            id,
                            evaluated_at: (live.state.clock)(),
                        };
                        if let Some(frame) = encode_event(&resync) {
                            return Some((Ok(frame), live));
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => return None,
                }
            }
        }
    }
}

fn encode_event(ev: &OpsEvent) -> Option<Event> {
    let kind = ev.event_type();
    let frame = Event::default()
        .event(kind)
        .id(ev.id().to_string())
        .json_data(ev)
        .ok()?;
    metrics::counter!("ops_cockpit_sse_events_total", "type" => kind).increment(1);
    Some(frame)
}
