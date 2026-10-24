//! Per-request tenant context for the multi-tenant FSM.
//!
//! The application connects to Postgres as the non-owner, RLS-enforced `console_rt`
//! role. Every tenant-scoped query must arm the `app.current_org` GUC with the
//! org of the *authenticated request*, or RLS returns zero rows (fail-closed).
//!
//! This crate is the single source of that org for the lifetime of one request:
//!
//! * [`CURRENT_ORG`] is a tokio [`task_local!`] holding the request's [`OrgId`].
//!   The shared middleware enters it with [`tokio::task::LocalKey::scope`] around
//!   the downstream handler, so any code running on that task can read it.
//! * [`current_org`] reads it and FAILS CLOSED when unset — it never defaults to
//!   a tenant. Adapter read paths call `with_org_conn(pool, current_org()?, ..)`.
//! * [`resolve_principal`] is the one merged copy of the per-crate
//!   `principal_from_headers` extractors: bearer → verify → claims → org from the
//!   verified `org` claim → branch scope re-resolved from the DB (the safer
//!   policy: a membership revocation takes effect immediately).
//!
//! Note on `tokio::spawn`: a freshly spawned task does NOT inherit the
//! task-local. A handler that spawns work which itself touches tenant-scoped
//! tables must re-enter the scope, e.g. `CURRENT_ORG.scope(org, async { .. })`.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

mod access;
mod current_claims;
pub use current_claims::{validate_current_claims, validate_current_claims_in_tx};
pub mod audit_context;
mod commands;
pub mod conflict;
pub mod record_access;
mod refusals;
pub use refusals::record_refusal;
pub mod error_i18n;
mod error_response;
mod idle;
mod principal;
pub mod privacy;
pub mod rate_limit;
pub mod support;
mod support_problem;
pub use principal::resolve_principal_from_bearer_token;

use audit_context::{request_audit_context, session_family_id};
use error_response::{error_response, error_response_for};
use std::{collections::BTreeSet, net::IpAddr, net::SocketAddr, str::FromStr, sync::Arc};

use axum::extract::{ConnectInfo, Request};
use axum::middleware::Next;
use console_kernel_core::{
    AccessScope, AuditRequestContext, BranchScope, KernelError, OrgId, TraceContext, UserId,
};
use console_platform_auth::{AccessClaims, ActorSession, JwtVerifier, TenantAccessContext};
use console_platform_authz::{
    PlatformPrincipal, Principal, Role, SubjectFreshness, effective_branch_scope_for_tenant,
    resolve_effective_feature_grants_in_org,
};
use console_platform_group::group_admin_member_orgs;
use http::{HeaderMap, StatusCode};
use ipnet::IpNet;
use sqlx::PgPool;

tokio::task_local! {
    /// The tenant of the in-flight request. Set once per request by the shared
    /// middleware; read by [`current_org`].
    pub static CURRENT_ORG: OrgId;

    /// Trace and transport metadata captured once at the authenticated HTTP
    /// boundary, then reused by every audit event emitted by that request.
    static CURRENT_AUDIT_CONTEXT: RequestAuditContext;
}

/// Request-correlated metadata suitable for an [`console_kernel_core::AuditEvent`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestAuditContext {
    pub trace: TraceContext,
    pub request: AuditRequestContext,
    /// The bearer's refresh-token family (INF-02 `session_id`).
    pub session_id: Option<uuid::Uuid>,
}

/// Client address resolved by a trusted ingress boundary.
///
/// Request-context middleware never interprets forwarding headers. The ingress
/// that owns proxy trust policy must validate the chain and insert this
/// extension. Without it, audit metadata falls back only to the transport peer
/// supplied by Axum's [`ConnectInfo`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TrustedClientIp(IpAddr);

impl TrustedClientIp {
    #[must_use]
    pub const fn new(ip: IpAddr) -> Self {
        Self(ip)
    }

    #[must_use]
    pub const fn get(self) -> IpAddr {
        self.0
    }
}

/// Resolve the client IP at the sole trusted HTTP ingress boundary.
///
/// A forwarding header is considered only when the deployment explicitly
/// configures one or more trusted proxy hops *and* Axum supplied the direct
/// transport peer. `trusted_proxy_count` includes that direct peer, so only the
/// rightmost `trusted_proxy_count` `X-Forwarded-For` entries are read: the
/// remaining proxy hops, validated right-to-left against the trusted CIDRs, and
/// the client entry immediately to their left. Everything further left was
/// written by the client and is never parsed, so a junk or non-UTF-8 prefix
/// cannot push a caller into the proxy's shared bucket. Repeated fields are
/// joined in order (RFC 9110 §5.3), as the trusted proxy's own appending does.
/// A malformed, untrusted or missing entry inside that suffix falls back to the
/// direct peer; it never promotes an attacker-controlled header value. This is
/// the only place that interprets `X-Forwarded-For` in the HTTP process.
#[must_use]
pub fn resolve_trusted_client_ip(
    headers: &HeaderMap,
    peer: SocketAddr,
    trusted_proxy_count: usize,
    trusted_proxy_cidrs: &[IpNet],
) -> IpAddr {
    let trusted = |ip: &IpAddr| trusted_proxy_cidrs.iter().any(|net| net.contains(ip));
    if trusted_proxy_count == 0 || !trusted(&peer.ip()) {
        return peer.ip();
    }

    // Rightmost entry first, across fields in order.
    let mut entries = headers
        .get_all("x-forwarded-for")
        .iter()
        .rev()
        .flat_map(|value| value.as_bytes().rsplit(|byte| *byte == b','))
        .map(|entry| {
            std::str::from_utf8(entry)
                .ok()
                .and_then(|entry| entry.trim().parse::<IpAddr>().ok())
        });
    for _ in 1..trusted_proxy_count {
        if !matches!(entries.next(), Some(Some(hop)) if trusted(&hop)) {
            return peer.ip();
        }
    }
    entries.next().flatten().unwrap_or_else(|| peer.ip())
}

/// Insert a [`TrustedClientIp`] extension at the process ingress.
///
/// Call this once on the fully-composed app router. Domain routers and rate
/// limiters consume the extension and never parse raw forwarding headers.
pub fn with_trusted_client_ip<S>(
    router: axum::Router<S>,
    trusted_proxy_count: usize,
    trusted_proxy_cidrs: Vec<IpNet>,
) -> axum::Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    let trusted_proxy_cidrs: Arc<[IpNet]> = trusted_proxy_cidrs.into();
    router.layer(axum::middleware::from_fn(
        move |mut request: Request, next: Next| {
            let trusted_proxy_cidrs = Arc::clone(&trusted_proxy_cidrs);
            async move {
                if let Some(ConnectInfo(peer)) =
                    request.extensions().get::<ConnectInfo<SocketAddr>>()
                {
                    let client_ip = resolve_trusted_client_ip(
                        request.headers(),
                        *peer,
                        trusted_proxy_count,
                        &trusted_proxy_cidrs,
                    );
                    request
                        .extensions_mut()
                        .insert(TrustedClientIp::new(client_ip));
                }
                access::with_request_line(access::RequestLine::of(&request), next.run(request))
                    .await
            }
        },
    ))
}

/// Message of the 403 `passkey_required` refusal an OTP enrollment session
/// receives outside the enrollment surface.
pub const PASSKEY_REQUIRED_MESSAGE: &str = "enroll a passkey before performing this action";

/// Why a request could not be given a tenant context.
#[derive(Debug, thiserror::Error)]
pub enum RequestContextError {
    /// No tenant is bound to the current task — the request never passed through
    /// the org middleware, or read code ran outside the request task (e.g. a bare
    /// `tokio::spawn` that did not re-enter [`CURRENT_ORG`]). Fail closed.
    #[error("no tenant context is bound to the current request")]
    MissingOrg,

    /// The Authorization header was absent or malformed.
    #[error("missing or malformed bearer token")]
    MissingBearer,

    /// The bearer token failed verification.
    #[error("invalid bearer token")]
    InvalidToken,

    /// A claim in an otherwise-valid token did not parse (subject, role, or org).
    #[error("token claim is invalid: {0}")]
    InvalidClaim(&'static str),

    /// JWT verification is not configured for this deployment.
    #[error("jwt verification is not configured")]
    VerifierUnavailable,

    /// Resolving the live branch scope from the database failed.
    #[error("failed to resolve branch scope: {0}")]
    BranchScope(String),

    /// Resolving runtime-effective custom policy grants from the database failed.
    #[error("failed to resolve effective policy: {0}")]
    EffectivePolicy(String),

    /// The verified JWT's hierarchy scope is not valid for this tenant route.
    #[error("access scope is not valid for this route: {0}")]
    AccessScope(KernelError),

    /// A PLATFORM token was presented to a tenant (`/api/*`) route, or a TENANT
    /// token was presented to a `/api/platform/*` route. The two tiers are strictly
    /// separated; crossing them is rejected before any handler runs.
    #[error("token tier is not valid for this route")]
    WrongTokenTier,
}

impl From<RequestContextError> for KernelError {
    /// Adapters surface tenancy failures through their domain error, which
    /// already converts from [`KernelError`]. A missing/invalid request context
    /// at a data-access site is an internal invariant violation (a tenant-scoped
    /// query reached the DB without a bound org), so it maps to an internal
    /// error — the request never produces tenant data on this path.
    fn from(err: RequestContextError) -> Self {
        match err {
            RequestContextError::AccessScope(error) => error,
            err => KernelError::internal(err.to_string()),
        }
    }
}

/// Read the tenant bound to the current request task.
///
/// FAILS CLOSED: returns [`RequestContextError::MissingOrg`] when no org is in
/// scope. It NEVER falls back to a default tenant. Adapter reads wrap their query
/// in `with_org_conn(&self.pool, current_org()?, ..)`.
pub fn current_org() -> Result<OrgId, RequestContextError> {
    CURRENT_ORG
        .try_with(|org| *org)
        .map_err(|_| RequestContextError::MissingOrg)
}

/// Return the audit context bound by [`with_request_context`].
///
/// `None` means the caller is outside an authenticated HTTP request. Mutation
/// handlers must treat that as an invariant failure instead of fabricating an
/// unrelated trace at the persistence boundary.
#[must_use]
pub fn current_audit_context() -> Option<RequestAuditContext> {
    CURRENT_AUDIT_CONTEXT.try_with(Clone::clone).ok()
}

/// Extract the raw bearer token from an Authorization header.
fn bearer_token(headers: &HeaderMap) -> Result<&str, RequestContextError> {
    headers
        .get(http::header::AUTHORIZATION)
        .ok_or(RequestContextError::MissingBearer)?
        .to_str()
        .map_err(|_| RequestContextError::MissingBearer)?
        .strip_prefix("Bearer ")
        .filter(|token| !token.trim().is_empty())
        .ok_or(RequestContextError::MissingBearer)
}

/// Resolve the authenticated [`Principal`] for a request from its headers.
///
/// This is the single merged copy of the formerly-duplicated
/// `principal_from_headers` extractors:
/// 1. parse the bearer token,
/// 2. verify it (the verifier already rejects a token whose `org` claim is not a
///    valid UUID),
/// 3. parse subject and roles,
/// 4. take the tenant from the verified `org` claim,
/// 5. re-resolve the live branch scope from the database rather than trusting the
///    token's `branches` claim, so a membership revocation takes effect at once.
pub async fn resolve_principal(
    verifier: &JwtVerifier,
    pool: &PgPool,
    headers: &HeaderMap,
) -> Result<Principal, RequestContextError> {
    let token = bearer_token(headers)?;
    let resolved = resolve_principal_from_bearer_token(verifier, pool, token);
    idle::with_last_interaction(headers, resolved).await
}

// ---------------------------------------------------------------------------
// Axum middleware
// ---------------------------------------------------------------------------

/// Apply the per-request tenant-context middleware to one authenticated router.
///
/// Called by each domain `router()` (so the behavior is testable per crate and
/// composes in the app). For every route on `router` it resolves the
/// [`Principal`], stores it in the request extensions (handlers can read
/// `Extension<Principal>`), and runs the downstream handler inside the
/// [`CURRENT_ORG`] scope — arming the request's tenant for every adapter
/// read/write.
///
/// Fail-closed: a request that cannot be resolved to a principal is rejected
/// before any handler runs, so no tenant-scoped query can execute without an org.
///
/// Pass the router's own `jwt_verifier` and a clone of its `pool`. Do NOT apply
/// it to pre-auth routes (login/refresh) or the realtime WS upgrade.
pub fn with_request_context<S>(
    router: axum::Router<S>,
    verifier: Option<JwtVerifier>,
    pool: PgPool,
) -> axum::Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    router.layer(axum::middleware::from_fn(
        move |request: Request, next: Next| {
            let verifier = verifier.clone();
            let pool = pool.clone();
            async move {
                let Some(verifier) = verifier.as_ref() else {
                    return error_response(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "JWT verification is not configured",
                    );
                };
                let principal = match resolve_principal(verifier, &pool, request.headers()).await {
                    Ok(principal) => principal,
                    Err(err) => return error_response_for(&err),
                };
                privacy::run_tenant(&pool, verifier, principal, request, next).await
            }
        },
    ))
}

// ---------------------------------------------------------------------------
// Platform tier extractor + middleware
// ---------------------------------------------------------------------------

/// Resolve the authenticated [`PlatformPrincipal`] for a request from its
/// headers.
///
/// Mirrors [`resolve_principal`] but for the SaaS-vendor PLATFORM tier:
/// 1. parse + verify the bearer token,
/// 2. REQUIRE `platform = true` — a tenant token is rejected here, so a tenant
///    admin can never reach `/api/platform/*`,
/// 3. parse the subject.
///
/// It deliberately resolves NO tenant org and NO branch scope: a platform
/// principal is not tenant-scoped, and platform handlers arm the specific
/// TARGET org themselves per action.
pub async fn resolve_platform_principal(
    verifier: &JwtVerifier,
    pool: &PgPool,
    headers: &HeaderMap,
) -> Result<PlatformPrincipal, RequestContextError> {
    let claims = resolve_platform_claims(verifier, pool, headers).await?;
    let user_id = UserId::from_str(&claims.sub).map_err(|_| RequestContextError::InvalidToken)?;
    Ok(PlatformPrincipal::new(user_id))
}

async fn resolve_platform_claims(
    verifier: &JwtVerifier,
    pool: &PgPool,
    headers: &HeaderMap,
) -> Result<AccessClaims, RequestContextError> {
    let token = bearer_token(headers)?;
    let claims = verifier
        .verify_access_token(token)
        .map_err(|_| RequestContextError::InvalidToken)?;

    // Tier separation: ONLY a platform token may reach a `/api/platform/*` route.
    if !claims.platform {
        return Err(RequestContextError::WrongTokenTier);
    }

    idle::with_last_interaction(headers, validate_current_claims(pool, &claims)).await?;
    if claims.enrollment {
        return Err(RequestContextError::AccessScope(KernelError::forbidden(
            PASSKEY_REQUIRED_MESSAGE,
        )));
    }
    Ok(claims)
}

/// Apply the PLATFORM extractor middleware to a `/api/platform/*` router.
///
/// Resolves the [`PlatformPrincipal`] (rejecting any tenant token) and stores it
/// in the request extensions for handlers to read as `Extension<PlatformPrincipal>`.
/// It does NOT enter the [`CURRENT_ORG`] tenant scope: the platform tier is not
/// tenant-scoped, and each platform write arms the TARGET org explicitly.
///
/// Fail-closed: a request that cannot be resolved to a platform principal is
/// rejected before any handler runs.
pub fn with_platform_context<S>(
    router: axum::Router<S>,
    verifier: Option<JwtVerifier>,
    pool: PgPool,
) -> axum::Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    router.layer(axum::middleware::from_fn(
        move |request: Request, next: Next| {
            let verifier = verifier.clone();
            let pool = pool.clone();
            async move {
                let Some(verifier) = verifier.as_ref() else {
                    return error_response(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "JWT verification is not configured",
                    );
                };
                let claims = match resolve_platform_claims(verifier, &pool, request.headers()).await
                {
                    Ok(principal) => principal,
                    Err(RequestContextError::WrongTokenTier) => {
                        return error_response(
                            StatusCode::FORBIDDEN,
                            "token tier is not valid for this route",
                        );
                    }
                    Err(err) => return error_response_for(&err),
                };
                privacy::run_platform(&pool, verifier, claims, request, next).await
            }
        },
    ))
}

/// Wrap a handler body in the tenant scope, for tests / non-router callers that
/// need to execute adapter code with a known tenant bound.
pub async fn scope_org<F, T>(org: OrgId, fut: F) -> T
where
    F: std::future::Future<Output = T>,
{
    CURRENT_ORG.scope(org, fut).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audit_context::trusted_or_direct_client_ip;
    use axum::body::Body;
    use axum::extract::Extension;
    use axum::routing::get;
    use console_kernel_core::ErrorKind;
    use console_platform_authz::{Action, Feature, authorize_org_wide};
    use tower::Service;

    fn forwarded_headers(value: &'static str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", value.parse().unwrap());
        headers
    }

    fn forwarded_headers_bytes(value: &[u8]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            http::HeaderValue::from_bytes(value).unwrap(),
        );
        headers
    }

    fn request_with_network_metadata(
        forwarded_for: &str,
        direct_peer: &str,
        trusted_client: Option<&str>,
    ) -> Request {
        let mut request = Request::builder()
            .header("x-forwarded-for", forwarded_for)
            .body(Body::empty())
            .unwrap();
        request.extensions_mut().insert(ConnectInfo(
            direct_peer.parse::<SocketAddr>().expect("direct peer"),
        ));
        if let Some(trusted_client) = trusted_client {
            request.extensions_mut().insert(TrustedClientIp::new(
                trusted_client.parse().expect("trusted client IP"),
            ));
        }
        request
    }

    #[test]
    fn audit_ip_ignores_client_prepended_forwarded_value() {
        let request = request_with_network_metadata(
            "198.51.100.250, 203.0.113.7",
            "10.0.0.3:443",
            Some("203.0.113.7"),
        );
        assert_eq!(
            trusted_or_direct_client_ip(&request),
            Some("203.0.113.7".parse().unwrap())
        );
    }

    #[test]
    fn audit_ip_accepts_ingress_resolution_across_multiple_trusted_hops() {
        let request = request_with_network_metadata(
            "198.51.100.250, 203.0.113.7, 10.0.0.2",
            "10.0.0.3:443",
            Some("203.0.113.7"),
        );
        assert_eq!(
            trusted_or_direct_client_ip(&request),
            Some("203.0.113.7".parse().unwrap())
        );
    }

    #[test]
    fn audit_ip_uses_direct_peer_when_forwarded_chain_is_insufficient() {
        let request = request_with_network_metadata("203.0.113.7", "192.0.2.10:8443", None);
        assert_eq!(
            trusted_or_direct_client_ip(&request),
            Some("192.0.2.10".parse().unwrap())
        );
    }

    #[test]
    fn audit_ip_uses_direct_peer_when_forwarded_chain_is_invalid() {
        let request =
            request_with_network_metadata("not-an-ip, 203.0.113.7", "192.0.2.11:8443", None);
        assert_eq!(
            trusted_or_direct_client_ip(&request),
            Some("192.0.2.11".parse().unwrap())
        );
    }

    #[test]
    fn ingress_resolver_accepts_a_complete_trusted_proxy_suffix() {
        let headers = forwarded_headers("198.51.100.250, 10.0.0.2");
        let peer = "10.0.0.3:443".parse().unwrap();

        assert_eq!(
            resolve_trusted_client_ip(&headers, peer, 2, &["10.0.0.0/8".parse().unwrap()]),
            "198.51.100.250".parse::<IpAddr>().unwrap()
        );
    }

    #[test]
    fn ingress_resolver_joins_repeated_forwarded_fields_in_order() {
        let mut headers = HeaderMap::new();
        headers.append("x-forwarded-for", "198.51.100.251".parse().unwrap());
        headers.append(
            "x-forwarded-for",
            "198.51.100.250, 10.0.0.2".parse().unwrap(),
        );
        let peer = "10.0.0.3:443".parse().unwrap();

        assert_eq!(
            resolve_trusted_client_ip(&headers, peer, 2, &["10.0.0.0/8".parse().unwrap()]),
            "198.51.100.250".parse::<IpAddr>().unwrap(),
            "repeated fields are one comma-joined list (RFC 9110 section 5.3)"
        );
        headers.append("x-forwarded-for", "10.0.0.4".parse().unwrap());
        assert_eq!(
            resolve_trusted_client_ip(&headers, peer, 3, &["10.0.0.0/8".parse().unwrap()]),
            "198.51.100.250".parse::<IpAddr>().unwrap(),
            "the trusted suffix may span fields"
        );
    }

    #[test]
    fn ingress_resolver_ignores_client_written_entries_left_of_the_suffix() {
        let cidrs = ["10.0.0.0/8".parse().unwrap()];
        let peer = "10.0.0.3:443".parse().unwrap();
        for prefix in ["garbage", "unknown, 203.0.113.9:4711", ""] {
            let headers =
                forwarded_headers_bytes(format!("{prefix}, 198.51.100.250, 10.0.0.2").as_bytes());
            assert_eq!(
                resolve_trusted_client_ip(&headers, peer, 2, &cidrs),
                "198.51.100.250".parse::<IpAddr>().unwrap(),
                "a bad entry left of the trusted suffix is never parsed: {prefix:?}"
            );
        }
        let headers = forwarded_headers_bytes(b"\xff\xfe junk, 198.51.100.250, 10.0.0.2");
        assert_eq!(
            resolve_trusted_client_ip(&headers, peer, 2, &cidrs),
            "198.51.100.250".parse::<IpAddr>().unwrap(),
            "a non-UTF-8 client prefix cannot collapse callers into the peer bucket"
        );
    }

    #[test]
    fn ingress_resolver_rejects_empty_forwarded_tokens() {
        let headers = forwarded_headers("198.51.100.250, , 10.0.0.2");
        let peer = "10.0.0.3:443".parse().unwrap();

        assert_eq!(
            resolve_trusted_client_ip(&headers, peer, 2, &["10.0.0.0/8".parse().unwrap()]),
            peer.ip(),
            "empty forwarded tokens must not be silently discarded"
        );
    }

    #[test]
    fn ingress_resolver_rejects_malformed_forwarded_tokens() {
        let headers = forwarded_headers("198.51.100.250, not-an-ip, 10.0.0.2");
        let peer = "10.0.0.3:443".parse().unwrap();

        assert_eq!(
            resolve_trusted_client_ip(&headers, peer, 2, &["10.0.0.0/8".parse().unwrap()]),
            peer.ip(),
            "malformed forwarded tokens must fail closed"
        );
    }

    #[test]
    fn ingress_resolver_rejects_an_untrusted_configured_proxy_suffix() {
        let headers = forwarded_headers("198.51.100.250, 203.0.113.7");
        let peer = "10.0.0.3:443".parse().unwrap();

        assert_eq!(
            resolve_trusted_client_ip(&headers, peer, 2, &["10.0.0.0/8".parse().unwrap()]),
            peer.ip(),
            "an untrusted suffix cannot be treated as an intermediary proxy"
        );
    }

    #[test]
    fn ingress_resolver_never_uses_raw_xff_without_a_configured_proxy() {
        let headers = forwarded_headers("198.51.100.250");
        let peer = "10.0.0.3:443".parse().unwrap();

        assert_eq!(resolve_trusted_client_ip(&headers, peer, 0, &[]), peer.ip());
        assert_eq!(
            resolve_trusted_client_ip(&headers, peer, 2, &["10.0.0.0/8".parse().unwrap()]),
            peer.ip(),
            "a short chain cannot turn a caller header into the trusted client"
        );
    }

    #[test]
    fn ingress_resolver_rejects_xff_from_an_untrusted_transport_peer() {
        let headers = forwarded_headers("198.51.100.250");
        let peer = "192.0.2.10:443".parse().unwrap();
        assert_eq!(
            resolve_trusted_client_ip(&headers, peer, 1, &["10.0.0.0/8".parse().unwrap()]),
            peer.ip()
        );
    }

    #[tokio::test]
    async fn ingress_middleware_reuses_proxy_policy_and_rejects_a_spoofed_suffix() {
        let mut app = with_trusted_client_ip(
            axum::Router::new().route(
                "/",
                get(
                    |Extension(client_ip): Extension<TrustedClientIp>| async move {
                        client_ip.get().to_string()
                    },
                ),
            ),
            2,
            vec!["10.0.0.0/8".parse().unwrap()],
        );
        let peer: SocketAddr = "10.0.0.3:443".parse().unwrap();

        for (forwarded_for, expected) in [
            ("198.51.100.250, 10.0.0.2", "198.51.100.250"),
            ("198.51.100.250, 203.0.113.7", "10.0.0.3"),
            ("garbage, 198.51.100.250, 10.0.0.2", "198.51.100.250"),
        ] {
            let mut request = Request::builder()
                .uri("/")
                .header("x-forwarded-for", forwarded_for)
                .body(Body::empty())
                .unwrap();
            request.extensions_mut().insert(ConnectInfo(peer));

            let response = Service::call(&mut app, request).await.unwrap();
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            assert_eq!(body.as_ref(), expected.as_bytes());
        }
    }

    #[tokio::test]
    async fn trusted_request_metadata_propagates_exactly_to_audit_context() {
        let mut request = request_with_network_metadata(
            "198.51.100.250, 203.0.113.7",
            "10.0.0.3:443",
            Some("203.0.113.7"),
        );
        request.headers_mut().insert(
            "traceparent",
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
                .parse()
                .unwrap(),
        );
        request
            .headers_mut()
            .insert(http::header::USER_AGENT, "audit-test/1.0".parse().unwrap());
        request
            .headers_mut()
            .insert("x-device-id", "trusted-device".parse().unwrap());

        let expected = RequestAuditContext {
            trace: TraceContext::new("4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7")
                .unwrap(),
            request: AuditRequestContext {
                ip: Some("203.0.113.7".to_owned()),
                user_agent: Some("audit-test/1.0".to_owned()),
                auth_method: Some("bearer".to_owned()),
                device: Some("trusted-device".to_owned()),
            },
            session_id: None,
        };
        assert_eq!(request_audit_context(&request, None), expected);
        CURRENT_AUDIT_CONTEXT
            .scope(expected.clone(), async {
                assert_eq!(current_audit_context(), Some(expected));
            })
            .await;
        assert_eq!(current_audit_context(), None);
    }

    #[tokio::test]
    async fn nested_audit_context_scope_restores_outer_then_clears() {
        let outer = RequestAuditContext {
            trace: TraceContext::new("11111111111111111111111111111111", "1111111111111111")
                .unwrap(),
            request: AuditRequestContext {
                device: Some("outer-device".to_owned()),
                ..AuditRequestContext::default()
            },
            session_id: None,
        };
        let inner = RequestAuditContext {
            trace: TraceContext::new("22222222222222222222222222222222", "2222222222222222")
                .unwrap(),
            request: AuditRequestContext {
                device: Some("inner-device".to_owned()),
                ..AuditRequestContext::default()
            },
            session_id: None,
        };

        assert_eq!(current_audit_context(), None);
        CURRENT_AUDIT_CONTEXT
            .scope(outer.clone(), async {
                assert_eq!(current_audit_context(), Some(outer.clone()));
                CURRENT_AUDIT_CONTEXT
                    .scope(inner.clone(), async {
                        assert_eq!(current_audit_context(), Some(inner));
                    })
                    .await;
                assert_eq!(current_audit_context(), Some(outer));
            })
            .await;
        assert_eq!(current_audit_context(), None);
    }

    #[test]
    fn delegated_group_admin_principal_does_not_gain_executive_queue_triage() -> Result<(), String>
    {
        let principal = Principal::new(
            UserId::new(),
            OrgId::new(),
            BTreeSet::from([Role::Admin]),
            BranchScope::All,
        );

        let err = match authorize_org_wide(&principal, Action::new(Feature::OrgWideQueueTriage)) {
            Ok(()) => {
                return Err(
                    "delegated group-admin tenant context gained executive queue triage".to_owned(),
                );
            }
            Err(err) => err,
        };
        assert_eq!(err.kind, ErrorKind::Forbidden);
        Ok(())
    }
}
