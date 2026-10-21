//! Worker egress fence (TOP-A2; ADR-015 §6.4).
//!
//! Before a worker claims any job with an external effect (mail, push, outbound
//! webhooks) it asks [`EgressFence::is_open`]. The fence opens only on positive
//! evidence that this site is the live one: a fresh Cloudflare API read of the
//! `console` CNAME whose content equals this site's tunnel target. Public DNS
//! cannot answer that (a proxied CNAME resolves to anycast A records).
//!
//! * A mismatching read trips the fence at once.
//! * Read failures trip it once they have lasted `fail_after`; until then the
//!   last known state holds.
//! * A tripped fence stays closed whatever later reads say. It is cleared only
//!   by a person: restarting the worker. A restarted fence starts closed and
//!   opens on its first matching read, so a restart during a failover (CNAME
//!   elsewhere) re-trips immediately and a restart during an outage stays
//!   closed. Same "fail closed when the authority is unavailable" rule as
//!   `platform/db/src/durability.rs`.
//!
//! Serving HTTP never consults the fence.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

pub mod cloudflare;
mod settings;

pub use settings::{FenceConfigError, FenceMode, FenceStubMode, LiveFenceConfig, read_mode};

/// How often the refresher reads the CNAME (ADR-015 §6.4, TOP-A2: 60 s).
pub const REFRESH_EVERY: Duration = Duration::from_secs(60);

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Why a fence is closed for good (until a restart).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TripReason {
    /// The CNAME points somewhere else (`None`: no CNAME record at all).
    Mismatch { observed: Option<String> },
    /// The authority could not be read for at least `fail_after`.
    Unreachable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FenceState {
    /// Closed until the first matching read.
    Pending,
    Open,
    /// Closed until a person restarts the worker.
    Tripped(TripReason),
}

#[derive(Debug, thiserror::Error)]
#[error("egress fence authority read failed: {0}")]
pub struct FenceReadError(pub String);

/// The authority: returns the CNAME content, or `None` when no CNAME exists.
pub trait CnameReader: Send + Sync {
    fn read(&self) -> BoxFuture<'_, Result<Option<String>, FenceReadError>>;
}

#[derive(Debug)]
struct Inner {
    state: FenceState,
    expected: String,
    fail_after: Duration,
    failing_since: Option<Instant>,
}

/// Shared, cheap-to-clone fence handle.
#[derive(Debug, Clone)]
pub struct EgressFence {
    inner: Arc<Mutex<Inner>>,
}

impl EgressFence {
    /// A live fence for this site's tunnel target. Starts [`FenceState::Pending`].
    #[must_use]
    pub fn new(expected_content: &str, fail_after: Duration) -> Self {
        Self::with_state(FenceState::Pending, expected_content, fail_after)
    }

    /// Always open, for explicit non-production stub modes only.
    #[must_use]
    pub fn open_for_stub(_mode: FenceStubMode) -> Self {
        Self::with_state(FenceState::Open, "", Duration::ZERO)
    }

    /// Never opens: no authority configured. External effects stay paused.
    #[must_use]
    pub fn unconfigured() -> Self {
        Self::with_state(FenceState::Pending, "", Duration::ZERO)
    }

    fn with_state(state: FenceState, expected: &str, fail_after: Duration) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                state,
                expected: normalize(expected),
                fail_after,
                failing_since: None,
            })),
        }
    }

    #[must_use]
    pub fn is_open(&self) -> bool {
        self.state() == FenceState::Open
    }

    #[must_use]
    pub fn state(&self) -> FenceState {
        self.lock().state.clone()
    }

    /// Apply one authority read taken at `now`.
    pub fn observe(&self, read: Result<Option<&str>, &FenceReadError>, now: Instant) {
        let mut inner = self.lock();
        if matches!(inner.state, FenceState::Tripped(_)) {
            return;
        }
        match read {
            Ok(Some(content))
                if !inner.expected.is_empty() && normalize(content) == inner.expected =>
            {
                if inner.state != FenceState::Open {
                    tracing::info!(target: "console::egress_fence", "egress fence opened");
                }
                inner.state = FenceState::Open;
                inner.failing_since = None;
            }
            Ok(observed) => {
                let observed = observed.map(str::to_owned);
                tracing::error!(target: "console::egress_fence", ?observed, "egress fence tripped: CNAME mismatch");
                inner.state = FenceState::Tripped(TripReason::Mismatch { observed });
            }
            Err(err) => {
                let since = *inner.failing_since.get_or_insert(now);
                tracing::warn!(target: "console::egress_fence", error = %err, "egress fence authority read failed");
                if now.saturating_duration_since(since) >= inner.fail_after {
                    tracing::error!(target: "console::egress_fence", "egress fence tripped: authority unreachable");
                    inner.state = FenceState::Tripped(TripReason::Unreachable);
                }
            }
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // A poisoned lock only means a panic elsewhere mid-update; the state is
        // a plain enum, so reading it is still sound.
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn normalize(content: &str) -> String {
    content.trim().trim_end_matches('.').to_ascii_lowercase()
}

/// Read the authority every `every` and feed the fence, forever.
pub async fn refresh_forever(fence: EgressFence, reader: Arc<dyn CnameReader>, every: Duration) {
    let mut tick = tokio::time::interval(every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        let read = reader.read().await;
        fence.observe(
            read.as_ref().map(|content| content.as_deref()),
            Instant::now(),
        );
    }
}

/// Build the fence from `CONSOLE_EGRESS_FENCE_*` and, when live, spawn its
/// refresher on the current tokio runtime. The composition root's one line.
pub fn start(var: impl Fn(&str) -> Option<String>) -> Result<EgressFence, FenceConfigError> {
    Ok(match read_mode(var)? {
        FenceMode::Live(config) => {
            let fence = EgressFence::new(&config.expected_content, config.fail_after);
            let reader = cloudflare::CloudflareCnameReader::new(&config)
                .map_err(|err| FenceConfigError(err.to_string()))?;
            tokio::spawn(refresh_forever(
                fence.clone(),
                Arc::new(reader),
                REFRESH_EVERY,
            ));
            fence
        }
        FenceMode::Stub(mode) => {
            tracing::warn!(target: "console::egress_fence", %mode, "egress fence stubbed open (non-production)");
            EgressFence::open_for_stub(mode)
        }
        FenceMode::Unconfigured => {
            tracing::warn!(target: "console::egress_fence", "egress fence not configured: external-effect jobs stay paused");
            EgressFence::unconfigured()
        }
    })
}

#[cfg(test)]
mod tests;
