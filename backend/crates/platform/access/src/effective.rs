//! Effective access of one account (or the caller), the ops holder, and
//! 「ops 사용 기록」.

use std::collections::BTreeMap;

use console_kernel_core::OrgId;
use console_platform_authz::Principal;
use console_platform_authz::access::{
    AccessSlice, Domain, Enforcement, Level, action_group, load_access_subject, load_tenant_phase,
};
use console_platform_db::with_org_conn;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

use crate::AccessService;
use crate::actor::{Actor, read_actor};
use crate::caveats::caveats;
use crate::error::{AccessError, AccessResult};
use crate::grants_store::{self as store, ListFilter};
use crate::roles_store::lines_of;

fn rfc3339(t: OffsetDateTime) -> AccessResult<String> {
    t.format(&Rfc3339).map_err(AccessError::internal)
}

/// One row per live grant × domain × level. An ENFORCED row is re-decided by
/// Cedar on the account's own slice; a denial there (a voided 사업장, a broken
/// chain) reads `SCOPE_UNAVAILABLE`; every row of a deactivated account reads
/// `ACCOUNT_INACTIVE`.
async fn effective_of(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    account: Uuid,
) -> AccessResult<Value> {
    let is_ops = store::account(tx, org, account)
        .await?
        .ok_or_else(|| AccessError::not_found("account_not_found", "no such account"))?
        .1;
    let now = OffsetDateTime::now_utc();
    let phase = load_tenant_phase(tx, org).await?;
    let subject = load_access_subject(tx, org, account, now).await?;
    let held: BTreeMap<Uuid, _> = subject
        .grants
        .iter()
        .map(|g| (g.grant_id, g.scope.clone()))
        .collect();
    let slice = AccessSlice::compile(&subject).ok();
    let filter = ListFilter {
        account_id: Some(account),
        ..ListFilter::default()
    };
    let noticed = crate::notice::noticed(tx, org, account).await?;
    let mut entries = Vec::new();
    for grant in store::list(tx, org, &filter, phase, now).await? {
        let version: i32 =
            sqlx::query_scalar("SELECT version FROM access_roles WHERE org_id = $1 AND id = $2")
                .bind(org.as_uuid())
                .bind(grant.role_id)
                .fetch_one(tx.as_mut())
                .await?;
        for line in lines_of(tx, org, grant.role_id, version).await? {
            for level in &line.levels {
                let enforcement = match grant.enforcement {
                    // people-self-46: a deactivated account uses nothing.
                    _ if !grant.account_active => "ACCOUNT_INACTIVE",
                    Enforcement::Enforced => {
                        let cedar =
                            held.get(&grant.id)
                                .zip(slice.as_ref())
                                .is_some_and(|(path, s)| {
                                    s.allows(&action_group(line.domain, *level), path)
                                        .unwrap_or(false)
                                });
                        if cedar {
                            "ENFORCED"
                        } else {
                            "SCOPE_UNAVAILABLE"
                        }
                    }
                    other => match other {
                        Enforcement::Prepared => "PREPARED",
                        Enforcement::Scheduled => "SCHEDULED",
                        Enforcement::Ended => "ENDED",
                        Enforcement::Revoked => "REVOKED",
                        _ => "ROLE_INACTIVE",
                    },
                };
                entries.push(json!({
                    "caveats": caveats(line.domain, *level, grant.scope.kind),
                    "domain": line.domain, "level": level, "scope": grant.scope,
                    "grant_id": grant.id, "role_id": grant.role_id, "role_name_ko": grant.role_name_ko,
                    "valid_from": rfc3339(grant.valid_from)?,
                    "valid_to": grant.valid_to.map(rfc3339).transpose()?,
                    "enforcement": enforcement,
                    "noticed_at": noticed.get(&grant.id.to_string()).copied().map(rfc3339).transpose()?,
                }));
            }
        }
    }
    Ok(json!({
        "account_id": account, "is_ops": is_ops, "phase": phase.as_str(),
        "as_of": rfc3339(now)?, "entries": entries,
    }))
}

pub async fn account(s: &AccessService, p: Principal, account: Uuid) -> AccessResult<Value> {
    read_actor(s, &p).await?.require_access(Level::View)?;
    let out = with_org_conn::<_, _, AccessError>(&s.pool, p.org_id, move |tx| {
        Box::pin(async move { effective_of(tx, p.org_id, account).await })
    })
    .await?;
    Ok(out)
}

pub async fn me(s: &AccessService, p: Principal) -> AccessResult<Value> {
    let me = *p.user_id.as_uuid();
    let out = with_org_conn::<_, _, AccessError>(&s.pool, p.org_id, move |tx| {
        Box::pin(async move { effective_of(tx, p.org_id, me).await })
    })
    .await?;
    Ok(out)
}

pub async fn ops(s: &AccessService, p: Principal) -> AccessResult<Value> {
    read_actor(s, &p).await?.require_access(Level::View)?;
    let out = with_org_conn::<_, _, AccessError>(&s.pool, p.org_id, move |tx| {
        Box::pin(async move {
            let row = sqlx::query(
                "SELECT id, display_name FROM users WHERE org_id = $1 AND is_tenant_ops",
            )
            .bind(p.org_id.as_uuid())
            .fetch_optional(tx.as_mut())
            .await?
            .ok_or_else(|| {
                AccessError::not_found("ops_account_missing", "this tenant has no ops account")
            })?;
            Ok(json!({
                "account_id": row.try_get::<Uuid, _>("id")?,
                "display_name": row.try_get::<String, _>("display_name")?,
            }))
        })
    })
    .await?;
    Ok(out)
}

#[derive(Debug, Deserialize)]
pub struct UsageQuery {
    #[serde(default, with = "time::serde::rfc3339::option")]
    before: Option<OffsetDateTime>,
    limit: Option<i64>,
}

pub async fn ops_usage(s: &AccessService, p: Principal, q: UsageQuery) -> AccessResult<Vec<Value>> {
    let actor: Actor = read_actor(s, &p).await?;
    if !actor.may(Domain::Audit, Level::View, &actor.tenant()) {
        return Err(AccessError::access_denied());
    }
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let out = with_org_conn::<_, _, AccessError>(&s.pool, p.org_id, move |tx| {
        Box::pin(async move {
            let rows = sqlx::query(
                "SELECT at, account_id, method, path, session_family_id FROM access_ops_usage
                  WHERE org_id = $1 AND ($2::timestamptz IS NULL OR at < $2)
                  ORDER BY at DESC, id LIMIT $3",
            )
            .bind(p.org_id.as_uuid())
            .bind(q.before)
            .bind(limit)
            .fetch_all(tx.as_mut())
            .await?;
            rows.iter()
                .map(|r| {
                    Ok(json!({
                        "at": rfc3339(r.try_get("at")?)?,
                        "account_id": r.try_get::<Uuid, _>("account_id")?,
                        "method": r.try_get::<String, _>("method")?,
                        "path": r.try_get::<String, _>("path")?,
                        "session_family_id": r.try_get::<Option<Uuid>, _>("session_family_id")?,
                    }))
                })
                .collect::<AccessResult<Vec<_>>>()
        })
    })
    .await?;
    Ok(out)
}
