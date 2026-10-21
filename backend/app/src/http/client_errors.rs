//! B-01: the first-party client error beacon, `POST /api/v1/client-errors`.
//!
//! The SPA's `public/error-beacon.js` reports a white screen from any cause
//! (an uncaught error, a rejected promise, a chunk or stylesheet that failed
//! to load, a boot that never rendered) with `navigator.sendBeacon` to our own
//! origin: no third-party RUM (PIPA §28-8). Unauthenticated by necessity (a
//! page that never booted has no session), so it touches no database, takes a
//! closed vocabulary only (no message, no query, no form value), refuses
//! cross-site browser posts, and is capped per client IP and globally.
//! Contract: scratchpad `ops/contracts.md` "B-01".

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::MethodRouter;
use axum::{Extension, Json};
use console_platform_request_context::TrustedClientIp;
use console_platform_request_context::rate_limit::{GLOBAL_TRIPS_TOTAL, ip_key};
use serde::Deserialize;

pub(crate) const CLIENT_ERRORS_TOTAL: &str = "console_client_errors_total";
pub(crate) const WEB_BUILD_INFO: &str = "console_web_build_info";
pub(crate) const MAX_BODY_BYTES: usize = 2048;
const WINDOW: Duration = Duration::from_secs(60);
pub(crate) const PER_IP_CAP: u32 = 120;
pub(crate) const GLOBAL_CAP: u32 = 1200;
/// Distinct `build` label values one process keeps; the rest are `other`.
pub(crate) const MAX_BUILDS: usize = 8;
/// Bound on the per-IP map inside one window; past it only the global cap applies.
const MAX_TRACKED_IPS: usize = 10_000;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Beacon {
    kind: Kind,
    build: String,
    route: String,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Kind {
    Error,
    Rejection,
    Resource,
    Preload,
    Boot,
}

impl Kind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Rejection => "rejection",
            Self::Resource => "resource",
            Self::Preload => "preload",
            Self::Boot => "boot",
        }
    }
}

fn token(value: &str, max: usize, extra: &[char]) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || extra.contains(&c))
}

impl Beacon {
    fn valid(&self) -> bool {
        token(&self.build, 16, &['-'])
            && self.route.starts_with('/')
            && token(&self.route, 64, &['-', '/', ':', '.'])
            && self.name.as_deref().is_none_or(|name| token(name, 40, &[]))
    }
}

/// One fixed window: a global count and a bounded per-IP map.
#[derive(Debug)]
pub(crate) struct Limiter {
    start: Instant,
    global: u32,
    per_ip: HashMap<String, u32>,
}

impl Limiter {
    pub(crate) fn new(now: Instant) -> Self {
        Self {
            start: now,
            global: 0,
            per_ip: HashMap::new(),
        }
    }

    /// `Ok` when admitted; `Err(true)` when the global cap refused it.
    pub(crate) fn admit(&mut self, ip: Option<String>, now: Instant) -> Result<(), bool> {
        if now.duration_since(self.start) >= WINDOW {
            *self = Self::new(now);
        }
        if self.global >= GLOBAL_CAP {
            return Err(true);
        }
        if let Some(ip) = ip {
            let tracked = self.per_ip.len() < MAX_TRACKED_IPS || self.per_ip.contains_key(&ip);
            if tracked {
                let count = self.per_ip.entry(ip).or_insert(0);
                if *count >= PER_IP_CAP {
                    return Err(false);
                }
                *count += 1;
            }
        }
        self.global += 1;
        Ok(())
    }
}

/// The `build` label values this process has admitted. The dist it serves is
/// registered first, so its own build never falls to `other`.
#[derive(Debug, Default)]
pub(crate) struct Builds(Vec<String>);

impl Builds {
    pub(crate) fn label(&mut self, build: &str) -> String {
        if self.0.iter().any(|known| known == build) {
            return build.to_owned();
        }
        if self.0.len() < MAX_BUILDS {
            self.0.push(build.to_owned());
            return build.to_owned();
        }
        "other".to_owned()
    }
}

/// The served dist's build: the hash of `/assets/index-<hash>.js` in its
/// `index.html` (what the client reads from its entry script's URL).
pub(crate) fn dist_build(index_html: &str) -> Option<&str> {
    let start = index_html.find("/assets/index-")? + "/assets/index-".len();
    let rest = &index_html[start..];
    let hash = &rest[..rest.find(".js")?];
    token(hash, 16, &['-']).then_some(hash)
}

#[derive(Clone)]
struct Ingest {
    limiter: Arc<Mutex<Limiter>>,
    builds: Arc<Mutex<Builds>>,
}

/// The handler, with its own small body cap (it wins over the global 2 MiB),
/// mounted at `/api/v1/client-errors` by `routes::ops`. One limiter per
/// router, i.e. per api process.
/// caps are per replica; a shared (Postgres) bucket only if one
/// replica's 1200/min ever matters.
pub(crate) fn post<S: Clone + Send + Sync + 'static>(
    web_dist: Option<&std::path::Path>,
) -> MethodRouter<S> {
    let mut builds = Builds::default();
    let own = web_dist.and_then(|dist| std::fs::read_to_string(dist.join("index.html")).ok());
    if let Some(build) = own.as_deref().and_then(dist_build) {
        metrics::gauge!(WEB_BUILD_INFO, "build" => builds.label(build)).set(1.0);
    }
    axum::routing::post(ingest)
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(Ingest {
            limiter: Arc::new(Mutex::new(Limiter::new(Instant::now()))),
            builds: Arc::new(Mutex::new(builds)),
        })
}

/// A browser's cross-site post (OWASP Fetch Metadata); curl sends none.
fn cross_site(headers: &HeaderMap) -> bool {
    headers
        .get("sec-fetch-site")
        .is_some_and(|value| value != "same-origin" && value != "none")
}

fn refusal(status: StatusCode, code: &str) -> Response {
    let message = "client error beacon refused";
    let mut response = (
        status,
        Json(serde_json::json!({"error": {"code": code, "message": message}})),
    )
        .into_response();
    if status == StatusCode::TOO_MANY_REQUESTS {
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, HeaderValue::from_static("60"));
    }
    response
}

async fn ingest(
    State(ingest): State<Ingest>,
    headers: HeaderMap,
    client_ip: Option<Extension<TrustedClientIp>>,
    body: Bytes,
) -> Response {
    if cross_site(&headers) {
        return refusal(StatusCode::FORBIDDEN, "forbidden");
    }
    // IPv4 as is, IPv6 per /64 (one subscriber's allocation).
    let ip = client_ip.map(|Extension(ip)| ip_key(ip, 64));
    let admitted = ingest
        .limiter
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .admit(ip, Instant::now());
    if let Err(global) = admitted {
        if global {
            metrics::counter!(GLOBAL_TRIPS_TOTAL, "endpoint" => "client_errors").increment(1);
        }
        return refusal(StatusCode::TOO_MANY_REQUESTS, "rate_limited");
    }
    let beacon = match serde_json::from_slice::<Beacon>(&body) {
        Ok(beacon) if beacon.valid() => beacon,
        _ => return refusal(StatusCode::BAD_REQUEST, "invalid_client_error"),
    };
    let build = ingest
        .builds
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .label(&beacon.build);
    let kind = beacon.kind.as_str();
    metrics::counter!(CLIENT_ERRORS_TOTAL, "kind" => kind, "build" => build.clone()).increment(1);
    tracing::warn!(
        target: "client_errors",
        kind,
        build = %build,
        route = %beacon.route,
        name = beacon.name.as_deref().unwrap_or("-"),
        "client error beacon"
    );
    StatusCode::NO_CONTENT.into_response()
}

#[cfg(test)]
#[path = "client_errors_tests.rs"]
mod tests;
