//! The per-request audit metadata captured at the authenticated boundary
//! (INF-02 접속기록: 접속지, and the session the 취급자 acted in).

pub mod access_log;

use std::net::{IpAddr, SocketAddr};

use axum::extract::{ConnectInfo, Request};
use console_kernel_core::{AuditRequestContext, TraceContext};
use console_platform_auth::JwtVerifier;
use http::HeaderMap;
use uuid::Uuid;

use super::{RequestAuditContext, TrustedClientIp, bearer_token};

pub(crate) fn request_audit_context(
    request: &Request,
    session_id: Option<Uuid>,
) -> RequestAuditContext {
    let headers = request.headers();
    RequestAuditContext {
        trace: trace_context(headers),
        request: AuditRequestContext {
            ip: trusted_or_direct_client_ip(request).map(|ip| ip.to_string()),
            user_agent: header_text(headers, http::header::USER_AGENT.as_str()).map(str::to_owned),
            auth_method: Some("bearer".to_owned()),
            device: header_text(headers, "x-device-id").map(str::to_owned),
        },
        session_id,
    }
}

/// The refresh-token family the bearer was minted from: the acting account's
/// own family, or the home family of a delegated (group admin) session.
// verifies the bearer a second time after resolve_principal; return
// the family from resolve_principal if the extra verify ever shows in profiles.
pub(crate) fn session_family_id(verifier: &JwtVerifier, headers: &HeaderMap) -> Option<Uuid> {
    let claims = verifier
        .verify_access_token(bearer_token(headers).ok()?)
        .ok()?;
    claims
        .actor_session
        .map(|session| session.family_id)
        .or(claims.session_family_id)
}

pub(crate) fn trusted_or_direct_client_ip(request: &Request) -> Option<IpAddr> {
    request
        .extensions()
        .get::<TrustedClientIp>()
        .copied()
        .map(TrustedClientIp::get)
        .or_else(|| {
            request
                .extensions()
                .get::<ConnectInfo<SocketAddr>>()
                .map(|ConnectInfo(peer)| peer.ip())
        })
}

pub(crate) fn header_text<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(name)?
        .to_str()
        .ok()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

pub(crate) fn trace_context(headers: &HeaderMap) -> TraceContext {
    header_text(headers, "traceparent")
        .and_then(parse_traceparent)
        .unwrap_or_else(TraceContext::generate)
}

pub(crate) fn parse_traceparent(value: &str) -> Option<TraceContext> {
    let mut fields = value.split('-');
    let version = fields.next()?;
    let trace_id = fields.next()?;
    let span_id = fields.next()?;
    let flags = fields.next()?;
    if fields.next().is_some()
        || version == "ff"
        || !is_lower_hex(version, 2)
        || !is_lower_hex(flags, 2)
        || trace_id.bytes().all(|byte| byte == b'0')
        || span_id.bytes().all(|byte| byte == b'0')
    {
        return None;
    }
    TraceContext::new(trace_id, span_id).ok()
}

fn is_lower_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}
