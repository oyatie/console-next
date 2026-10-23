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
use console_platform_authz::{Principal, SupportPrincipal};
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
    tx.commit().await.map_err(SupportError::from)?;
    let mut principal = Principal::new(user, org, BTreeSet::new(), BranchScope::All);
    principal.support = Some(SupportPrincipal {
        session_id: id,
        operator_label: session.operator_label,
        scope: session.scope,
        reveal_classes: session.reveal_classes,
    });
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
    if !matches!(*request.method(), Method::GET | Method::HEAD) {
        return Err(SupportError::Refused("support.refuse.read_only"));
    }
    let surface: Option<(String, String,Vec<String>,Value)> =
        sqlx::query_as("SELECT domain,feature,classification_tables,field_classes FROM support_read_surfaces WHERE path=$1")
            .bind(&path)
            .fetch_optional(tx.as_mut())
            .await?;
    let Some((domain, feature, tables, aliases)) = surface else {
        return Err(SupportError::Refused("support.refuse.out_of_scope"));
    };
    if !session.scope.contains(&domain) {
        return Err(SupportError::Refused("support.refuse.out_of_scope"));
    }
    let feature = console_platform_authz::Feature::from_str(&feature)
        .map_err(|_| SupportError::Refused("internal"))?;
    if !console_platform_authz::cedar_pbac::actions::support_session::decide_feature(
        feature,
        &id.to_string(),
        &org.to_string(),
        console_platform_authz::cedar_pbac::actions::support_session::Facts {
            active: true,
            operator_approved: session.operator_approver_ref.is_some(),
            tenant_approved: session.tenant_approved_at.is_some(),
            in_scope: true,
            ..Default::default()
        },
    ) {
        return Err(SupportError::Refused("support.refuse.out_of_scope"));
    }
    tx.commit().await?;
    crate::validate_current_claims(pool, &claims)
        .await
        .map_err(|_| SupportError::Refused("support.refuse.session_ended"))?;
    let response = next.run(request).await;
    // Lock again after the read: revocation during a slow handler withholds the response too.
    let mut tx = pool.begin().await?;
    let session = support::lock(&mut tx, org, id).await?;
    support::live(&session, OffsetDateTime::now_utc())?;
    let mut classes = field_classes(&mut tx, &tables).await?;
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
    mask(&mut value, &classes, &session.reveal_classes);
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

/// Classification comes from the schema; ambiguous aliases and unclassified derived fields stay masked.
async fn field_classes(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    tables: &[String],
) -> Result<BTreeMap<String, String>, SupportError> {
    let rows:Vec<(String,String)>=sqlx::query_as("SELECT a.attname, CASE WHEN bool_and(COALESCE(col_description(c.oid,a.attnum) LIKE 'pd:none %',false)) THEN 'metadata' WHEN bool_and(COALESCE(col_description(c.oid,a.attnum) LIKE 'pd:personal %',false)) THEN 'personal' ELSE 'sensitive' END FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped AND c.relkind='r' AND c.relname=ANY($1) GROUP BY a.attname")
        .bind(tables).fetch_all(tx.as_mut()).await?;
    Ok(rows.into_iter().collect())
}

fn mask(value: &mut Value, classes: &BTreeMap<String, String>, grants: &[String]) {
    match value {
        Value::Array(rows) => {
            for row in rows {
                mask(row, classes, grants);
            }
        }
        Value::Object(object) => {
            for (key, value) in object {
                if value.is_object() || value.is_array() {
                    mask(value, classes, grants);
                    continue;
                }
                let class = classes.get(key).map_or("sensitive", String::as_str);
                if class != "metadata"
                    && !grants.iter().any(|grant| grant == class)
                    && !value.is_null()
                {
                    *value = if value.is_string() {
                        Value::String("••••".into())
                    } else {
                        Value::Null
                    };
                }
            }
        }
        _ => *value = Value::Null,
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
mod tests {
    use super::*;
    #[test]
    fn unknown_and_sensitive_fields_stay_masked_with_a_personal_grant() {
        let classes = BTreeMap::from([
            ("count".into(), "metadata".into()),
            ("name".into(), "personal".into()),
            ("rrn".into(), "sensitive".into()),
        ]);
        let mut value =
            json!({"items":[{"name":"이름","rrn":"protected","phone":"private","count":2}]});
        mask(&mut value, &classes, &[]);
        assert_eq!(value["items"][0]["name"], "••••");
        assert_eq!(value["items"][0]["count"], 2);
        let mut value = json!({"name":"이름","rrn":"protected"});
        mask(&mut value, &classes, &["personal".into()]);
        assert_eq!(value["name"], "이름");
        assert_eq!(value["rrn"], "••••");
    }
}
