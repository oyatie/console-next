// SPDX-License-Identifier: LicenseRef-Proprietary
//! The support boundary covers every HTTP surface, including auth and realtime.
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::Request,
    middleware::Next,
    response::Response,
};
use console_kernel_core::{BranchScope, OrgId, UserId};
use console_platform_auth::{AccessClaims, JwtVerifier};
use console_platform_authz::{
    Principal,
    cedar_pbac::{
        actions::support_session::{self, Action, PrincipalKind},
        visible::load_support_session,
    },
};
use console_platform_db::support::{self, SupportError};
use http::{Method, StatusCode, header};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{
    collections::{BTreeMap, BTreeSet},
    str::FromStr,
};
use time::OffsetDateTime;
use uuid::Uuid;

pub use crate::support_problem::{refusal, with_support_problem_details};

pub(crate) async fn principal(
    pool: &PgPool,
    claims: &AccessClaims,
    user: UserId,
    org: OrgId,
    id: Uuid,
) -> Result<Principal, SupportError> {
    let mut tx = pool.begin().await.map_err(SupportError::from)?;
    let session = support::lock(&mut tx, org, id).await?;
    support::live(&session, OffsetDateTime::now_utc())?;
    if session.operator_ref != *user.as_uuid()
        || session.state != "ACTIVE"
        || session.tenant_approved_at.is_none()
        || session.operator_approver_ref.is_none()
    {
        return Err(SupportError::Refused("support.refuse.not_tenant_approved"));
    }
    if claims.exp > session.expires_at.map_or(0, |time| time.unix_timestamp()) {
        return Err(SupportError::Refused("support.refuse.session_ended"));
    }
    let facts = load_support_session(&mut tx, org, id)
        .await
        .map_err(|_| SupportError::Refused("internal"))?;
    tx.commit().await.map_err(SupportError::from)?;
    let mut principal = Principal::new(user, org, BTreeSet::new(), BranchScope::none());
    principal.support = Some(facts);
    Ok(principal)
}

pub fn with_support_gate<S: Clone + Send + Sync + 'static>(
    router: Router<S>,
    verifier: Option<JwtVerifier>,
    pool: PgPool,
) -> Router<S> {
    router.layer(axum::middleware::from_fn(
        move |request: Request, next: Next| {
            let verifier = verifier.clone();
            let pool = pool.clone();
            async move {
                let token = request
                    .headers()
                    .get(header::AUTHORIZATION)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.strip_prefix("Bearer "))
                    .or_else(|| websocket_token(request.headers()));
                let claims = verifier
                    .as_ref()
                    .zip(token)
                    .and_then(|(v, t)| v.verify_support_token(t).ok());
                let Some(claims) = claims else {
                    return next.run(request).await;
                };
                let method = request.method().to_string();
                let path = request.uri().path().to_owned();
                let transport =
                    crate::audit_context::request_audit_context(&request, claims.support);
                let response = match run(&pool, claims.clone(), request, next).await {
                    Ok(response) => response,
                    Err(error) => refusal(&error),
                };
                let response = crate::support_problem::normalize(response).await;
                match record(&pool, &claims, &method, &path, response.status(), transport).await {
                    Ok(()) => response,
                    Err(error) => refusal(&error),
                }
            }
        },
    ))
}

async fn run(
    pool: &PgPool,
    claims: AccessClaims,
    request: Request,
    next: Next,
) -> Result<Response, SupportError> {
    let org = OrgId::from_str(&claims.org)
        .map_err(|_| SupportError::Refused("support.refuse.session_ended"))?;
    let id = claims
        .support
        .ok_or(SupportError::Refused("support.refuse.session_ended"))?;
    let mut tx = pool.begin().await?;
    let session = support::lock(&mut tx, org, id).await?;
    support::live(&session, OffsetDateTime::now_utc())?;
    if claims.exp <= OffsetDateTime::now_utc().unix_timestamp() {
        return Err(SupportError::Refused("support.refuse.session_expired"));
    }
    if session.state != "ACTIVE" {
        return Err(SupportError::Refused("support.refuse.not_tenant_approved"));
    }
    let path = request.uri().path().to_owned();
    if path.ends_with("/reveal")
        && !session
            .reveal_classes
            .iter()
            .any(|class| class == "sensitive")
    {
        return Err(SupportError::Refused("support.refuse.reveal_not_granted"));
    }
    let loaded = load_support_session(&mut tx, org, id)
        .await
        .map_err(|_| SupportError::Refused("internal"))?;
    if !matches!(*request.method(), Method::GET | Method::HEAD) {
        support_session::require(
            Action::Write,
            PrincipalKind::Support,
            &id.to_string(),
            &org.to_string(),
            &org.to_string(),
            loaded.facts(None, None),
        )
        .map_err(SupportError::Refused)?;
    }
    let surface: Option<(String, String, Value)> = sqlx::query_as(
        "SELECT domain,feature,field_classes FROM support_read_surfaces WHERE path=$1",
    )
    .bind(&path)
    .fetch_optional(tx.as_mut())
    .await?;
    let Some((domain, feature, aliases)) = surface else {
        return Err(SupportError::Refused("support.refuse.out_of_scope"));
    };
    let feature = console_platform_authz::Feature::from_str(&feature)
        .map_err(|_| SupportError::Refused("internal"))?;
    support_session::require_feature(
        feature,
        &id.to_string(),
        &org.to_string(),
        loaded.facts(Some(&domain), None),
    )
    .map_err(SupportError::Refused)?;
    tx.commit().await?;
    crate::validate_current_claims(pool, &claims)
        .await
        .map_err(|_| SupportError::Refused("support.refuse.session_ended"))?;
    let response = next.run(request).await;
    // Lock again after the read: revocation during a slow handler withholds the response too.
    let mut tx = pool.begin().await?;
    let session = support::lock(&mut tx, org, id).await?;
    support::live(&session, OffsetDateTime::now_utc())?;
    let loaded = load_support_session(&mut tx, org, id)
        .await
        .map_err(|_| SupportError::Refused("internal"))?;
    support_session::require_feature(
        feature,
        &id.to_string(),
        &org.to_string(),
        loaded.facts(Some(&domain), None),
    )
    .map_err(SupportError::Refused)?;
    let mut classes = BTreeMap::new();
    if let Value::Object(aliases) = aliases {
        for (field, class) in aliases {
            if let Some(class) = class.as_str() {
                classes.insert(field, class.to_owned());
            }
        }
    }
    tx.commit().await?;
    let (mut parts, body) = response.into_parts();
    parts.headers.insert(
        header::CACHE_CONTROL,
        http::HeaderValue::from_static("no-store"),
    );
    if !parts
        .headers
        .get(header::CONTENT_TYPE)
        .is_some_and(|v| v.as_bytes().starts_with(b"application/json"))
    {
        if parts.status.is_success() {
            return Err(SupportError::Refused("support.refuse.out_of_scope"));
        }
        return Ok(Response::from_parts(parts, body));
    }
    let bytes = to_bytes(body, usize::MAX)
        .await
        .map_err(|_| SupportError::Refused("internal"))?;
    let mut value: Value =
        serde_json::from_slice(&bytes).map_err(|_| SupportError::Refused("internal"))?;
    let visible: Vec<String> = classes
        .values()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter(|class| loaded.field_visible(&domain, class))
        .cloned()
        .collect();
    mask(&mut value, &classes, &visible, "");
    parts.headers.remove(header::CONTENT_LENGTH);
    let bytes = serde_json::to_vec(&value).map_err(|_| SupportError::Refused("internal"))?;
    Ok(Response::from_parts(parts, Body::from(bytes)))
}

async fn record(
    pool: &PgPool,
    claims: &AccessClaims,
    method: &str,
    path: &str,
    status: StatusCode,
    transport: crate::RequestAuditContext,
) -> Result<(), SupportError> {
    let org = OrgId::from_str(&claims.org)
        .map_err(|_| SupportError::Refused("support.refuse.session_ended"))?;
    let id = claims
        .support
        .ok_or(SupportError::Refused("support.refuse.session_ended"))?;
    let mut tx = pool.begin().await?;
    let session = support::lock(&mut tx, org, id).await?;
    if status.is_success() {
        support::live(&session, OffsetDateTime::now_utc())?;
    }
    support::audit(&mut tx,org,id,session.operator_ref,&session.operator_label,true,"support.access",json!({"kind":"공급사","method":method,"path":path,"status":status.as_u16(),"masked":session.masked}),Some((transport.trace,transport.request))).await?;
    tx.commit().await?;
    Ok(())
}

fn field_class<'a>(classes: &'a BTreeMap<String, String>, path: &str) -> Option<&'a str> {
    let mut suffix = path;
    loop {
        if let Some(class) = classes.get(suffix) {
            return Some(class);
        }
        suffix = suffix.split_once('.')?.1;
    }
}

fn mask(value: &mut Value, classes: &BTreeMap<String, String>, grants: &[String], path: &str) {
    let class = field_class(classes, path);
    let visible = |class: &str| grants.iter().any(|grant| grant == class);
    // Only reviewed containers may expose children; a familiar leaf name cannot bless an unknown object.
    if (value.is_object() || value.is_array())
        && !path.is_empty()
        && class != Some("container")
        && !class.is_some_and(visible)
    {
        *value = Value::Null;
        return;
    }
    match value {
        Value::Array(rows) => {
            for row in rows {
                mask(row, classes, grants, path);
            }
        }
        Value::Object(object) => {
            for (key, value) in object {
                let child = if path.is_empty() {
                    key.to_owned()
                } else {
                    format!("{path}.{key}")
                };
                mask(value, classes, grants, &child);
            }
        }
        _ if !visible(class.unwrap_or("sensitive")) && !value.is_null() => {
            *value = if value.is_string() {
                Value::String("••••".into())
            } else {
                Value::Null
            };
        }
        _ => {}
    }
}

fn websocket_token(headers: &http::HeaderMap) -> Option<&str> {
    let mut protocols = headers
        .get(header::SEC_WEBSOCKET_PROTOCOL)?
        .to_str()
        .ok()?
        .split(',')
        .map(str::trim);
    while let Some(protocol) = protocols.next() {
        if protocol == "bearer" {
            return protocols.next();
        }
    }
    None
}

#[cfg(test)]
#[path = "support/tests.rs"]
mod tests;
