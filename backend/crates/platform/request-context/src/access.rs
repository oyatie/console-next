//! The pilot access model at the request boundary (decision #26).
//!
//! For every tenant principal: load the account's grants that count now (the
//! phase rule included), let Cedar project them onto the existing doors, and —
//! when the account is the tenant's ops account — append one 「ops 사용 기록」
//! row. The row and the grants are read and written in one tenant transaction;
//! if the row cannot be written the request is refused (every ops use logged).

use std::collections::BTreeSet;

use console_kernel_core::{AccessScope, OrgId, UserId};
use console_platform_authz::access::{Projection, load_access_subject, project, union_branches};
use console_platform_authz::{
    Principal, Role, SubjectFreshness, effective_branch_scope_for_tenant,
    resolve_branch_scope_in_org, resolve_effective_feature_grants_in_org,
};
use console_platform_db::{DbError, with_org_conn};
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::RequestContextError;

tokio::task_local! {
    /// Method and path of the in-flight HTTP request, scoped once at the
    /// ingress boundary ([`crate::with_trusted_client_ip`]).
    static REQUEST_LINE: RequestLine;
}

#[derive(Clone, Debug)]
pub(crate) struct RequestLine {
    method: String,
    path: String,
}

impl RequestLine {
    pub(crate) fn of<B>(request: &http::Request<B>) -> Self {
        Self {
            method: request.method().as_str().to_owned(),
            path: request.uri().path().chars().take(512).collect(),
        }
    }
}

/// Run `fut` with `line` as the request line.
pub(crate) async fn with_request_line<F: Future>(line: RequestLine, fut: F) -> F::Output {
    REQUEST_LINE.scope(line, fut).await
}

/// The tenant principal: legacy branches and custom-role grants, widened by
/// exactly the branches the account's Cedar-allowed tenant grants cover
/// (before the token's access scope narrows it), plus the ops flag.
pub(crate) async fn tenant_principal(
    pool: &PgPool,
    user_id: UserId,
    org_id: OrgId,
    roles: BTreeSet<Role>,
    access_scope: AccessScope,
    authz_freshness: SubjectFreshness,
    session_family: Option<Uuid>,
) -> Result<Principal, RequestContextError> {
    let role_vec = roles.iter().copied().collect::<Vec<_>>();
    let live_branch_scope = resolve_branch_scope_in_org(pool, org_id, user_id, &role_vec)
        .await
        .map_err(|err| RequestContextError::BranchScope(err.to_string()))?;
    let access = resolve_access(pool, org_id, *user_id.as_uuid(), session_family)
        .await
        .map_err(RequestContextError::EffectivePolicy)?;
    let live_branch_scope = union_branches(&live_branch_scope, &access.projection.branches);
    let branch_scope = effective_branch_scope_for_tenant(live_branch_scope, access_scope, org_id)
        .map_err(RequestContextError::AccessScope)?;
    let mut effective_feature_grants =
        resolve_effective_feature_grants_in_org(pool, org_id, user_id, &branch_scope)
            .await
            .map_err(|err| RequestContextError::EffectivePolicy(err.to_string()))?;
    effective_feature_grants.extend(access.projection.grants);
    // AX-5: the grant set rides only on a whole-tenant token; a token narrowed
    // to a branch or region (legacy) carries none (fail closed).
    let scope_grants = if access_scope == AccessScope::legacy_org(org_id) {
        access.projection.scoped
    } else {
        Vec::new()
    };
    Ok(Principal::new(user_id, org_id, roles, branch_scope)
        .with_scope_grants(scope_grants)
        .with_access_scope(access_scope)
        .with_effective_feature_grants(effective_feature_grants)
        .with_authz_freshness(authz_freshness)
        .with_tenant_ops(access.is_ops))
}

/// What the access model adds to one principal.
struct AccessResolution {
    pub is_ops: bool,
    pub projection: Projection,
}

#[derive(Debug)]
struct LoadError(String);

impl From<DbError> for LoadError {
    fn from(err: DbError) -> Self {
        Self(err.to_string())
    }
}

/// # Errors
/// The grants or the ops row could not be read or written (fail closed).
async fn resolve_access(
    pool: &PgPool,
    org: OrgId,
    account: Uuid,
    session_family: Option<Uuid>,
) -> Result<AccessResolution, String> {
    let now = OffsetDateTime::now_utc();
    let line = REQUEST_LINE.try_with(Clone::clone).unwrap_or(RequestLine {
        method: "-".to_owned(),
        path: "(outside an HTTP request)".to_owned(),
    });
    let subject = with_org_conn::<_, _, LoadError>(pool, org, move |tx| {
        Box::pin(async move {
            let subject = load_access_subject(tx, org, account, now)
                .await
                .map_err(|e| LoadError(e.to_string()))?;
            if subject.is_ops {
                sqlx::query(
                    "INSERT INTO access_ops_usage (org_id, account_id, session_family_id, method, path)
                     VALUES ($1, $2, $3, $4, $5)",
                )
                .bind(org.as_uuid())
                .bind(account)
                .bind(session_family)
                .bind(&line.method)
                .bind(&line.path)
                .execute(tx.as_mut())
                .await
                .map_err(|e| LoadError(format!("ops usage row: {e}")))?;
            }
            Ok(subject)
        })
    })
    .await
    .map_err(|LoadError(e)| e)?;
    let projection = project(&subject);
    for err in &projection.errors {
        tracing::warn!(org = %org, error = %err, "authz_eval_error: an access grant was denied");
    }
    Ok(AccessResolution {
        is_ops: subject.is_ops,
        projection,
    })
}
