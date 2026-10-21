//! Public transport evidence: only a heartbeat, through the real LISTEN connection.
use std::sync::Arc;

use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{
    IntoResponse, Response,
    sse::{Event, Sse},
};

use crate::{PgRealtimeHub, SOCKET_IO_TIMEOUT};

impl PgRealtimeHub {
    /// Bounded and fail-closed; never creates a tenant subscription or principal.
    pub async fn status_heartbeat(&self) -> bool {
        let Some(sender) = self.status_ping.lock().await.clone() else {
            return false;
        };
        let (reply, receive) = tokio::sync::oneshot::channel();
        if sender.try_send(reply).is_err() {
            return false;
        }
        tokio::time::timeout(SOCKET_IO_TIMEOUT, receive)
            .await
            .is_ok_and(|result| result == Ok(true))
    }
}

pub async fn heartbeat(hub: Arc<PgRealtimeHub>) -> Response {
    if !hub.status_heartbeat().await {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    // A finite stream bounds unauthenticated connections and contains no event IDs or data.
    let frames = futures::stream::once(async {
        Ok::<_, std::convert::Infallible>(Event::default().comment("heartbeat"))
    });
    let mut response = Sse::new(frames).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
        .headers_mut()
        .insert("x-accel-buffering", HeaderValue::from_static("no"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn status_refuses_unstarted_full_and_failed_listener() {
        let hub = Arc::new(PgRealtimeHub::for_tests(Default::default()));
        assert!(!hub.status_heartbeat().await);
        assert_eq!(
            heartbeat(hub.clone()).await.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
        *hub.status_ping.lock().await = Some(sender.clone());
        let (reply, _) = tokio::sync::oneshot::channel();
        sender.try_send(reply).unwrap();
        assert!(
            !hub.status_heartbeat().await,
            "busy listener refuses without queuing"
        );
        receiver.recv().await.unwrap();
        tokio::spawn(async move {
            receiver.recv().await.unwrap().send(false).unwrap();
        });
        assert!(!hub.status_heartbeat().await);
        assert!(
            !hub.status_heartbeat().await,
            "stopped listener is not healthy"
        );
    }
}
