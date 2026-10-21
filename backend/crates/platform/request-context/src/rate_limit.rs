//! The one fixed-window limiter for unauthenticated endpoints (auth, the
//! public sales and support inquiries).
//!
//! Counters live in Postgres (`auth_rate_limit`, shared by every instance);
//! each caller keeps its own UPSERT and passes it in as `increment`. This
//! module owns the bucket keys and the in-process pre-filter that refuses a
//! bucket already seen over its cap without touching the database, so a flood
//! past the cap costs no connection.

use std::collections::HashMap;
use std::future::Future;
use std::net::{IpAddr, Ipv6Addr};
use std::sync::{Mutex, OnceLock};

use http::HeaderMap;
use time::{Duration, OffsetDateTime};

use crate::TrustedClientIp;

/// Fixed-window length.
pub const WINDOW: Duration = Duration::minutes(1);

/// Caps per window for one endpoint, and the IPv6 prefix an address bucket
/// counts (64 = one subscriber's allocation; 56 for endpoints that take a
/// guessable secret or write, so a /48 holder gets 256 buckets, not 65 536).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Caps {
    pub per_ip: i64,
    pub per_device: i64,
    pub global: i64,
    pub ipv6_prefix: u8,
}

/// Counter of trips of an endpoint's `global` bucket (everyone is refused
/// for the rest of the window): alert on it rather than tune the cap.
pub const GLOBAL_TRIPS_TOTAL: &str = "rate_limit_global_trips_total";

/// The key an address bucket counts: IPv4 as is, IPv6 by its `/prefix`.
pub fn ip_key(ip: TrustedClientIp, ipv6_prefix: u8) -> String {
    match ip.get() {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => {
            let bits = u32::from(ipv6_prefix.min(128));
            let mask = u128::MAX.checked_shl(128 - bits).unwrap_or(0);
            format!("{}/{bits}", Ipv6Addr::from(u128::from(v6) & mask))
        }
    }
}

/// The optional, client-controlled `X-Device-Id`; bounded length and charset.
/// When absent or malformed the per-device bucket is skipped.
pub fn device_id(headers: &HeaderMap) -> Option<String> {
    let value = headers.get("x-device-id")?.to_str().ok()?.trim();
    if value.is_empty()
        || value.len() > 128
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return None;
    }
    Some(value.to_owned())
}

/// Floor a timestamp to the start of its window.
pub fn floor_to_window(now: OffsetDateTime) -> OffsetDateTime {
    let window_secs = WINDOW.whole_seconds().max(1);
    let unix = now.unix_timestamp();
    OffsetDateTime::from_unix_timestamp(unix - unix.rem_euclid(window_secs)).unwrap_or(now)
}

/// Count this request in its per-IP, per-device and global buckets for
/// `endpoint`. `Ok(false)` once any bucket is over its cap (the caller answers
/// 429). `increment(key, window_start)` is the caller's UPSERT returning the
/// bucket's new count.
pub async fn admit<E, F, Fut>(
    endpoint: &'static str,
    caps: Caps,
    headers: &HeaderMap,
    client_ip: Option<TrustedClientIp>,
    now: OffsetDateTime,
    mut increment: F,
) -> Result<bool, E>
where
    F: FnMut(String, OffsetDateTime) -> Fut,
    Fut: Future<Output = Result<i64, E>>,
{
    let window = floor_to_window(now);
    let mut buckets = Vec::with_capacity(3);
    if let Some(ip) = client_ip {
        buckets.push((format!("ip:{}", ip_key(ip, caps.ipv6_prefix)), caps.per_ip));
    }
    if let Some(device) = device_id(headers) {
        buckets.push((format!("dev:{device}"), caps.per_device));
    }
    buckets.push(("global".to_owned(), caps.global));
    for (key, cap) in buckets {
        let over = match prefilter::seen(endpoint, &key, window) {
            Some(count) if count > cap => true,
            _ => {
                let count = increment(key.clone(), window).await?;
                prefilter::record(endpoint, &key, window, count);
                count > cap
            }
        };
        if over {
            if key == "global" {
                metrics::counter!(GLOBAL_TRIPS_TOTAL, "endpoint" => endpoint).increment(1);
            }
            return Ok(false);
        }
    }
    Ok(true)
}

/// Last database count seen per `(endpoint, bucket)` in the current window.
/// Within a window a count only grows, so a bucket seen over its cap is still
/// over it on every instance: refusing from here is exact, not approximate.
mod prefilter {
    use super::*;

    // entry cap, then the pre-filter is skipped (the database still
    // counts); a time-wheel if an attacker can churn 100k keys per minute.
    const MAX_ENTRIES: usize = 100_000;

    type Seen = HashMap<(&'static str, String), (OffsetDateTime, i64)>;

    fn map() -> &'static Mutex<Seen> {
        static SEEN: OnceLock<Mutex<Seen>> = OnceLock::new();
        SEEN.get_or_init(Default::default)
    }

    pub(super) fn seen(endpoint: &'static str, key: &str, window: OffsetDateTime) -> Option<i64> {
        let map = map().lock().ok()?;
        match map.get(&(endpoint, key.to_owned())) {
            Some((at, count)) if *at == window => Some(*count),
            _ => None,
        }
    }

    pub(super) fn record(endpoint: &'static str, key: &str, window: OffsetDateTime, count: i64) {
        let Ok(mut map) = map().lock() else { return };
        if map.len() >= MAX_ENTRIES {
            map.retain(|_, (at, _)| *at == window);
            if map.len() >= MAX_ENTRIES {
                return;
            }
        }
        map.insert((endpoint, key.to_owned()), (window, count));
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;
    use std::convert::Infallible;
    use std::sync::atomic::{AtomicI64, Ordering};

    const CAPS: Caps = Caps {
        per_ip: 2,
        per_device: 10,
        global: 100,
        ipv6_prefix: 56,
    };

    fn key(ip: &str, prefix: u8) -> String {
        ip_key(TrustedClientIp::new(ip.parse().unwrap()), prefix)
    }

    #[test]
    fn ipv6_is_keyed_by_the_endpoint_prefix_and_ipv4_by_address() {
        assert_eq!(key("203.0.113.50", 56), "203.0.113.50");
        assert_eq!(key("2001:db8:1:2:aaaa::1", 64), "2001:db8:1:2::/64");
        assert_ne!(key("2001:db8:1:3::1", 64), key("2001:db8:1:2::1", 64));
        // One /56 (256 /64s) is one bucket; the next /56 is another.
        assert_eq!(key("2001:db8:1:2ff::1", 56), "2001:db8:1:200::/56");
        assert_eq!(key("2001:db8:1:200::9", 56), key("2001:db8:1:2ff:1::", 56));
        assert_ne!(key("2001:db8:1:300::1", 56), key("2001:db8:1:200::1", 56));
    }

    #[test]
    fn device_ids_are_bounded() {
        let mut headers = HeaderMap::new();
        headers.insert("x-device-id", "dev-1.a_b".parse().unwrap());
        assert_eq!(device_id(&headers).as_deref(), Some("dev-1.a_b"));
        headers.insert("x-device-id", "a b".parse().unwrap());
        assert_eq!(device_id(&headers), None);
    }

    /// Past the cap the pre-filter refuses without another database write.
    #[tokio::test]
    async fn a_bucket_over_its_cap_is_refused_without_the_database() {
        let writes = AtomicI64::new(0);
        let headers = HeaderMap::new();
        let ip = Some(TrustedClientIp::new("198.51.100.9".parse().unwrap()));
        let now = OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap();
        let attempt = || {
            admit("test_prefilter", CAPS, &headers, ip, now, |_, _| {
                let n = writes.fetch_add(1, Ordering::SeqCst) + 1;
                async move { Ok::<_, Infallible>(n) }
            })
        };
        assert!(attempt().await.unwrap());
        // Each admitted request writes ip + global (one shared counter here).
        assert!(!attempt().await.unwrap(), "count 3 > cap 2");
        let after_trip = writes.load(Ordering::SeqCst);
        for _ in 0..5 {
            assert!(!attempt().await.unwrap());
        }
        assert_eq!(writes.load(Ordering::SeqCst), after_trip, "no DB write");
        // The next window starts clean.
        let later = now + WINDOW;
        let admitted = admit(
            "test_prefilter",
            CAPS,
            &HeaderMap::new(),
            ip,
            later,
            |_, _| async { Ok::<_, Infallible>(1) },
        )
        .await
        .unwrap();
        assert!(admitted);
    }
}
