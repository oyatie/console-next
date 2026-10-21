use crate::error::RestError;
use crate::limits::RATE_LIMIT_GLOBAL;
use crate::limits::RATE_LIMIT_LOGIN_START_PER_IP;
use crate::limits::RATE_LIMIT_PER_CALLER;
use crate::limits::RATE_LIMIT_PER_DEVICE;
use crate::limits::RATE_LIMIT_PER_IP;
use axum::http::HeaderMap;
use console_kernel_core::ErrorKind;
use console_platform_request_context::TrustedClientIp;
use console_platform_request_context::rate_limit::{self as shared, Caps};
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, Clone, Copy)]
pub(crate) enum RateLimitEndpoint {
    Signup,
    OtpRedeem,
    LoginStart,
    LoginStartIdentifier,
    DeviceLoginStart,
    DeviceLoginPoll,
    DeviceLoginApprove,
    LoginFinish,
    LoginFinishFailure,
    Refresh,
    AdminOtpIssue,
    AdminCredentialReset,
}

impl RateLimitEndpoint {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Signup => "signup",
            Self::OtpRedeem => "otp_redeem",
            Self::LoginStart => "login_start",
            Self::LoginStartIdentifier => "login_start_identifier",
            Self::DeviceLoginStart => "device_login_start",
            Self::DeviceLoginPoll => "device_login_poll",
            Self::DeviceLoginApprove => "device_login_approve",
            Self::LoginFinish => "login_finish",
            Self::LoginFinishFailure => "login_finish_failure",
            Self::Refresh => "refresh",
            Self::AdminOtpIssue => "admin_otp_issue",
            Self::AdminCredentialReset => "admin_credential_reset",
        }
    }

    /// Caps per window for [`rate_limit`]. Refresh and login finish are keyed
    /// per family / per credential instead (see [`rate_limit_key`]), so they
    /// never share an office's IP bucket.
    pub(crate) const fn caps(self) -> Caps {
        let (per_ip, per_device, global) = match self {
            // Starting a ceremony reveals nothing and checks nothing: size the IP
            // bucket for a corporate NAT and keep the global bucket far above any
            // real sign-in burst, so one noisy address cannot lock everyone out.
            // Approving a QR sign-in and finishing a passkey sign-in present an
            // unguessable token or a signature, so they get the same NAT sizing:
            // an office approving desktop sign-ins at 9am shares one address.
            Self::LoginStart
            | Self::DeviceLoginStart
            | Self::DeviceLoginApprove
            | Self::LoginFinish => (RATE_LIMIT_LOGIN_START_PER_IP, 30, 20_000),
            // A waiting desktop polls about every two seconds; 1 200/min per IP
            // lets ~40 desktops behind one NAT wait at once.
            Self::DeviceLoginPoll => (1_200, 60, 20_000),
            _ => (RATE_LIMIT_PER_IP, RATE_LIMIT_PER_DEVICE, RATE_LIMIT_GLOBAL),
        };
        // A guessable secret (OTP) or a write (sign-up): key IPv6 per /56, so
        // one /48 holder gets 256 buckets instead of 65 536.
        let ipv6_prefix = match self {
            Self::Signup | Self::OtpRedeem => 56,
            _ => 64,
        };
        Caps {
            per_ip,
            per_device,
            global,
            ipv6_prefix,
        }
    }
}

/// Enforce per-IP, per-device, and global fixed-window caps on an unauthenticated
/// auth endpoint, returning `429` when any bucket is exceeded.
///
/// The deployment is multi-instance, so the counters live in Postgres
/// (`auth_rate_limit`) and every instance increments the same row; the shared
/// limiter refuses a bucket already seen over its cap before any write. The
/// device id is an OPTIONAL, client-controlled `X-Device-Id` header: when absent
/// or malformed the per-device bucket is skipped, so the per-IP and global caps
/// always still apply. Because a device id can be rotated freely, the per-IP cap
/// is the real adversarial bound; the per-device cap only adds granularity for
/// legitimate shared-IP situations.
pub(crate) async fn rate_limit(
    pool: &PgPool,
    headers: &HeaderMap,
    trusted_client_ip: Option<TrustedClientIp>,
    endpoint: RateLimitEndpoint,
    now: OffsetDateTime,
) -> Result<(), RestError> {
    let endpoint_str = endpoint.as_str();
    let admitted = shared::admit(
        endpoint_str,
        endpoint.caps(),
        headers,
        trusted_client_ip,
        now,
        |key, window| async move { increment_rate_bucket(pool, &key, endpoint_str, window).await },
    )
    .await?;
    if admitted {
        Ok(())
    } else {
        Err(RestError::too_many_requests())
    }
}

/// Per-caller fixed-window cap on an authenticated admin credential action:
/// `429` once the caller exceeds [`RATE_LIMIT_PER_CALLER`] in the window.
pub(crate) async fn rate_limit_caller(
    pool: &PgPool,
    caller: Uuid,
    endpoint: RateLimitEndpoint,
    now: OffsetDateTime,
) -> Result<(), RestError> {
    rate_limit_key(
        pool,
        &format!("user:{caller}"),
        endpoint,
        RATE_LIMIT_PER_CALLER,
        now,
    )
    .await
}

/// One fixed-window bucket for `key` (a caller, credential or refresh family):
/// `429` once it exceeds `cap` in the window. Run it on an open transaction
/// to make the count part of that transaction (refresh does, so a refused
/// rotation neither spends the token nor holds a second connection).
pub(crate) async fn rate_limit_key<'e>(
    executor: impl sqlx::PgExecutor<'e>,
    key: &str,
    endpoint: RateLimitEndpoint,
    cap: i64,
    now: OffsetDateTime,
) -> Result<(), RestError> {
    let attempts =
        increment_rate_bucket(executor, key, endpoint.as_str(), floor_to_window(now)).await?;
    if attempts > cap {
        return Err(RestError::too_many_requests());
    }
    Ok(())
}

/// The address a per-IP bucket counts: IPv4 as is, IPv6 by its /64 (one
/// subscriber's allocation), so rotating through a /64 never opens fresh buckets.
pub(crate) fn rate_limit_ip_key(ip: TrustedClientIp) -> String {
    shared::ip_key(ip, 64)
}

/// The current window's count for one bucket, without counting this request.
pub(crate) async fn rate_bucket_attempts(
    pool: &PgPool,
    client_key: &str,
    endpoint: RateLimitEndpoint,
    now: OffsetDateTime,
) -> Result<i64, RestError> {
    let attempts: Option<i32> = sqlx::query_scalar(
        "SELECT attempts FROM auth_rate_limit \
         WHERE client_key = $1 AND endpoint = $2 AND window_start = $3",
    )
    .bind(client_key)
    .bind(endpoint.as_str())
    .bind(floor_to_window(now))
    // rls-arming: ok auth_rate_limit is a global table (no org_id, no RLS)
    .fetch_optional(pool)
    .await
    .map_err(|err| RestError::internal(err.to_string()))?;
    Ok(attempts.map_or(0, i64::from))
}

/// A passkey ceremony failure as a response: a database or serialization
/// fault is a 500 (logged, never echoed); anything the client sent or the
/// ceremony refused is a 401 carrying only `failure`.
pub(crate) fn passkey_error(
    err: console_platform_auth::AuthError,
    failure: &'static str,
) -> RestError {
    use console_platform_auth::AuthError;
    match err {
        AuthError::Sqlx(_) | AuthError::Db(_) | AuthError::Serde(_) | AuthError::Jwt(_) => {
            tracing::error!(error = %err, "passkey ceremony failed on the server");
            RestError::internal("passkey ceremony failed")
        }
        AuthError::Kernel(ref kernel) if kernel.kind == ErrorKind::Internal => {
            tracing::error!(error = %err, "passkey ceremony failed on the server");
            RestError::internal("passkey ceremony failed")
        }
        _ => RestError::unauthorized(failure),
    }
}

/// Atomically increment (or insert) the fixed-window counter for one bucket and
/// return the new attempt count. The UPSERT makes the increment correct across
/// concurrent requests and across app instances.
pub(crate) async fn increment_rate_bucket<'e>(
    executor: impl sqlx::PgExecutor<'e>,
    client_key: &str,
    endpoint: &str,
    window_start: OffsetDateTime,
) -> Result<i64, RestError> {
    let attempts: i32 = sqlx::query_scalar(
        r#"
        INSERT INTO auth_rate_limit (client_key, endpoint, window_start, attempts)
        VALUES ($1, $2, $3, 1)
        ON CONFLICT (client_key, endpoint, window_start)
        DO UPDATE SET attempts = auth_rate_limit.attempts + 1
        RETURNING attempts
        "#,
    )
    .bind(client_key)
    .bind(endpoint)
    .bind(window_start)
    // rls-arming: ok auth_rate_limit is a global table (no org_id, no RLS)
    .fetch_one(executor)
    .await
    .map_err(|err| RestError::internal(err.to_string()))?;
    Ok(i64::from(attempts))
}

/// Delete counter rows of windows that ended more than an hour ago (the
/// worker runs it on its maintenance tick). Every limiter of this table uses
/// a one-minute window, so nothing older is ever read again. Replica-safe:
/// two concurrent runs delete disjoint or already-gone rows.
pub async fn prune_rate_limit_windows(pool: &PgPool) -> Result<u64, sqlx::Error> {
    sqlx::query("DELETE FROM auth_rate_limit WHERE window_start < now() - interval '1 hour'")
        // rls-arming: ok auth_rate_limit is a global table (no org_id, no RLS)
        .execute(pool)
        .await
        .map(|done| done.rows_affected())
}

/// Floor a timestamp to the start of its fixed rate-limit window.
pub(crate) fn floor_to_window(now: OffsetDateTime) -> OffsetDateTime {
    shared::floor_to_window(now)
}

// The process ingress resolves the peer and forwarding chain once, then this
// rate limiter consumes only its [`TrustedClientIp`] extension.

#[cfg(test)]
mod tests {
    use super::{RateLimitEndpoint, rate_limit, rate_limit_ip_key, rate_limit_key};

    use axum::http::HeaderMap;
    use axum::http::StatusCode;

    use console_platform_request_context::TrustedClientIp;
    use sqlx::PgPool;

    use crate::limits::RATE_LIMIT_LOGIN_START_PER_IP;
    use crate::limits::RATE_LIMIT_PER_IP;
    use crate::limits::RATE_LIMIT_PER_REFRESH_FAMILY;
    use console_platform_request_context::rate_limit::WINDOW as RATE_LIMIT_WINDOW;
    use time::OffsetDateTime;
    use uuid::Uuid;

    #[test]
    fn ip_buckets_key_ipv6_by_its_64_and_ipv4_by_address() {
        let key = |ip: &str| rate_limit_ip_key(TrustedClientIp::new(ip.parse().unwrap()));
        assert_eq!(key("203.0.113.50"), "203.0.113.50");
        // Rotating through one /64 stays in one bucket; the next /64 is another.
        assert_eq!(key("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64");
        assert_eq!(key("2001:db8:1:2:ffff:1:2:3"), key("2001:db8:1:2::9"));
        assert_ne!(key("2001:db8:1:3::1"), key("2001:db8:1:2::1"));
    }

    #[test]
    fn device_login_approve_and_login_finish_are_nat_sized() {
        for endpoint in [
            RateLimitEndpoint::DeviceLoginApprove,
            RateLimitEndpoint::LoginFinish,
        ] {
            assert_eq!(endpoint.caps(), RateLimitEndpoint::LoginStart.caps());
        }
        let otp = RateLimitEndpoint::OtpRedeem.caps();
        assert_eq!(
            (otp.per_ip, otp.per_device, otp.global),
            (RATE_LIMIT_PER_IP, 10, 100)
        );
        assert_eq!(otp.ipv6_prefix, 56);
        assert_eq!(RateLimitEndpoint::Signup.caps().ipv6_prefix, 56);
        assert_eq!(RateLimitEndpoint::LoginStart.caps().ipv6_prefix, 64);
    }

    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn rate_limit_trips_at_cap_and_resets_after_window(pool: PgPool) {
        let headers = HeaderMap::new();
        let client_ip = Some(TrustedClientIp::new("203.0.113.50".parse().unwrap()));
        let window1 = OffsetDateTime::from_unix_timestamp(1_700_000_000).unwrap();

        for attempt in 0..RATE_LIMIT_PER_IP {
            rate_limit(
                &pool,
                &headers,
                client_ip,
                RateLimitEndpoint::OtpRedeem,
                window1,
            )
            .await
            .unwrap_or_else(|_| panic!("attempt {attempt} within the cap must not trip 429"));
        }

        let tripped = rate_limit(
            &pool,
            &headers,
            client_ip,
            RateLimitEndpoint::OtpRedeem,
            window1,
        )
        .await
        .expect_err("the request past the cap in the same window must trip 429");
        assert_eq!(tripped.status, StatusCode::TOO_MANY_REQUESTS);

        // Advancing past the fixed window resets the bucket.
        let window2 = window1 + RATE_LIMIT_WINDOW;
        rate_limit(
            &pool,
            &headers,
            client_ip,
            RateLimitEndpoint::OtpRedeem,
            window2,
        )
        .await
        .expect("a new window must reset the per-IP bucket");
    }

    /// One office behind one NAT address: hundreds of passkey sign-in starts in
    /// a minute pass; only the per-IP NAT cap trips.
    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn login_start_fits_an_office_behind_one_nat_address(pool: PgPool) {
        const { assert!(RATE_LIMIT_LOGIN_START_PER_IP >= 300) };
        let headers = HeaderMap::new();
        let office = Some(TrustedClientIp::new("198.51.100.7".parse().unwrap()));
        let now = OffsetDateTime::from_unix_timestamp(1_700_000_000).unwrap();
        for attempt in 0..RATE_LIMIT_LOGIN_START_PER_IP {
            rate_limit(&pool, &headers, office, RateLimitEndpoint::LoginStart, now)
                .await
                .unwrap_or_else(|_| panic!("office sign-in {attempt} must not trip 429"));
        }
        let tripped = rate_limit(&pool, &headers, office, RateLimitEndpoint::LoginStart, now)
            .await
            .expect_err("past the NAT cap the address is limited");
        assert_eq!(tripped.status, StatusCode::TOO_MANY_REQUESTS);
    }

    /// Refresh is limited per session family: one runaway family trips, another
    /// family (another browser in the same office) is untouched.
    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn refresh_limit_is_per_family_not_per_address(pool: PgPool) {
        let now = OffsetDateTime::from_unix_timestamp(1_700_000_000).unwrap();
        let runaway = format!("family:{}", Uuid::new_v4());
        for _ in 0..RATE_LIMIT_PER_REFRESH_FAMILY {
            rate_limit_key(
                &pool,
                &runaway,
                RateLimitEndpoint::Refresh,
                RATE_LIMIT_PER_REFRESH_FAMILY,
                now,
            )
            .await
            .unwrap();
        }
        let tripped = rate_limit_key(
            &pool,
            &runaway,
            RateLimitEndpoint::Refresh,
            RATE_LIMIT_PER_REFRESH_FAMILY,
            now,
        )
        .await
        .expect_err("the runaway family is limited");
        assert_eq!(tripped.status, StatusCode::TOO_MANY_REQUESTS);
        let neighbour = format!("family:{}", Uuid::new_v4());
        rate_limit_key(
            &pool,
            &neighbour,
            RateLimitEndpoint::Refresh,
            RATE_LIMIT_PER_REFRESH_FAMILY,
            now,
        )
        .await
        .expect("another family keeps refreshing");
    }
}
