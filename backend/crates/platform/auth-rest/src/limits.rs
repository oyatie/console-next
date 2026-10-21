use time::Duration;

pub(crate) const GROUP_ADMIN_TENANT_CONTEXT_TTL: Duration = Duration::minutes(15);
/// Default lifetime for an open-signup OTP. A self-service code is a bearer
/// secret delivered by email; 1h comfortably spans an enroll-now session while
/// keeping the leaked-code window short.
pub(crate) const DEFAULT_SIGNUP_OTP_TTL: Duration = Duration::hours(1);

/// Default admin-issued OTP lifetime when the issuer omits a TTL. Tightened to
/// 4h (from 24h): a bootstrap OTP is a bearer secret relayed out-of-band, so a
/// shorter default shrinks the window in which a leaked code is redeemable while
/// still comfortably spanning a single onboarding session. An issuer who needs
/// longer can pass an explicit `ttl_seconds`, clamped to [`MAX_OTP_TTL`].
pub(crate) const DEFAULT_OTP_TTL: Duration = Duration::hours(4);
/// Upper bound on a caller-specified OTP TTL; rejects absurd values. Tightened to
/// 24h (from 30d): no legitimate first sign-in needs a code that outlives a day.
pub(crate) const MAX_OTP_TTL: Duration = Duration::hours(24);

/// Lifetime of a cross-device passkey-enrollment HANDOFF code. Deliberately SHORT
/// (5 min, distinct from the 4h admin OTP): the handoff is minted by the user for
/// themselves and scanned onto a second device within seconds, so a tight window
/// keeps the leaked-code blast radius minimal for this credential-handoff path.
pub(crate) const ENROLL_HANDOFF_TTL: Duration = Duration::minutes(5);

/// Lifetime of a desktop-login QR handoff. The QR approve token and desktop poll
/// token are separate bearer secrets; both expire quickly like enrollment QR.
pub(crate) const DEVICE_LOGIN_HANDOFF_TTL: Duration = Duration::minutes(5);

/// Required first-login privacy/terms notice version. This is an engineering
/// control, not a substitute for counsel-approved policy text: bump it whenever
/// the required collection/use notice or service terms materially change so users
/// must accept the new version before initial passkey enrollment.
pub(crate) const REQUIRED_PRIVACY_TERMS_VERSION: &str = "kr-pipa-v1-2026-06-25";

/// Per-client-IP cap per window on unauthenticated auth endpoints that take a
/// guessable secret (OTP redeem, signup). Passkey login start and device login
/// use the NAT-sized caps in [`RateLimitEndpoint::limits`] instead.
pub(crate) const RATE_LIMIT_PER_IP: i64 = 10;
/// Per-device cap per window (device id is optional and client-controlled).
pub(crate) const RATE_LIMIT_PER_DEVICE: i64 = 10;
/// Global per-endpoint cap per window — defense-in-depth against distributed
/// guessing across many IPs/devices.
pub(crate) const RATE_LIMIT_GLOBAL: i64 = 100;
/// Per-caller cap per window on admin credential actions (OTP issue, reset),
/// which mint sign-in codes for other users.
pub(crate) const RATE_LIMIT_PER_CALLER: i64 = 10;
/// Per-IP cap per window on passkey login start and device-login start. Sized
/// for a whole office behind one NAT address (hundreds of people signing in at
/// 9am); a start only mints a challenge, so it guards nothing guessable.
pub(crate) const RATE_LIMIT_LOGIN_START_PER_IP: i64 = 300;
/// Cap per window on FAILED passkey login finishes for one credential from one
/// client address. Only failures count, and they count per address, so junk
/// finishes naming someone's (public) credential id lock out only the sender.
pub(crate) const RATE_LIMIT_PER_CREDENTIAL: i64 = 30;
/// Cap per window on identifier-first sign-in starts for one normalised
/// identifier (decisions #33), counted the same for unknown identifiers so a 429
/// says nothing about the account. A person retrying stays far below it.
pub(crate) const RATE_LIMIT_PER_IDENTIFIER: i64 = 20;
/// Per-refresh-family cap per window. Refresh tokens are 256-bit secrets, so the
/// limit bounds one session's churn (a runaway client), never an office's IP.
pub(crate) const RATE_LIMIT_PER_REFRESH_FAMILY: i64 = 60;
