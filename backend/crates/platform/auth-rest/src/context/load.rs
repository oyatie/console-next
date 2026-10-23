use crate::context::grants::resolve_feature_grant_keys_for_user;
use crate::error::RestError;
use console_kernel_core::BranchId;
use console_kernel_core::OrgId;
use console_kernel_core::UserId;
use console_platform_db::with_org_conn;
use sqlx::PgPool;
use sqlx::Row;
use uuid::Uuid;

#[derive(Debug)]
pub(crate) struct UserAuthContext {
    pub(crate) user_id: UserId,
    pub(crate) org_id: OrgId,
    pub(crate) display_name: String,
    pub(crate) username: String,
    pub(crate) roles: Vec<String>,
    pub(crate) branches: Vec<BranchId>,
    /// Live group roles resolved from owner-only grants at login/refresh time.
    /// Clients use these only for UI gating; group-admin endpoints re-resolve
    /// the grant from the database before every cross-tenant action.
    pub(crate) group_roles: Vec<String>,
    /// Runtime-effective custom-role feature keys resolved at login/refresh time
    /// for UI gating hints. Backend request authorization ignores the JWT hint
    /// and re-resolves custom policy from the database on every request.
    pub(crate) feature_grants: Vec<String>,
    /// Subject authorization freshness snapshot resolved from the DB at
    /// login/refresh time (Cedar/PBAC activation, ADR-0021), stamped into the
    /// access token so the shared request boundary can deny a stale subject.
    /// Zero is valid only while no version row exists.
    pub(crate) authz_subject_version: u64,
    pub(crate) authz_policy_version: u64,
    pub(crate) session_generation: u64,
}

/// Load a user's auth context when the caller already holds the request's tenant
/// (e.g. from the verified JWT `org` claim, before the org middleware arms the
/// GUC). `users` and `user_branches` are FORCE RLS, so as the non-owner `console_rt`
/// role these reads return ZERO rows unless the GUC is armed; this variant arms
/// it from `org` for the read transaction. A user whose row is not visible under
/// `org` (wrong tenant, or no such user) is an unauthorized request.
pub(crate) async fn load_user_auth_context_in_org(
    pool: &PgPool,
    org: OrgId,
    user_id: Uuid,
) -> Result<UserAuthContext, RestError> {
    let mut context = with_org_conn::<_, UserAuthContext, RestError>(pool, org, move |tx| {
        Box::pin(async move { load_user_auth_context_tx(tx, user_id).await })
    })
    .await?;
    context.feature_grants = resolve_feature_grant_keys_for_user(pool, &context).await?;
    Ok(context)
}

/// Load a user's auth context inside an EXISTING tenant-scoped transaction (the
/// `app.current_org` GUC must already be armed by the caller). Shared core of
/// [`load_user_auth_context_in_org`].
pub(crate) async fn load_user_auth_context_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: Uuid,
) -> Result<UserAuthContext, RestError> {
    let row = sqlx::query(
        r#"
        SELECT display_name, phone, roles, is_active, org_id
        FROM person_accounts_current
        WHERE id = $1
        "#,
    )
    .bind(user_id)
    .fetch_optional(tx.as_mut())
    .await
    .map_err(|err| RestError::internal(err.to_string()))?
    .ok_or_else(|| RestError::unauthorized("user not found"))?;

    let display_name: String = row
        .try_get("display_name")
        .map_err(|err| RestError::internal(err.to_string()))?;
    // The user's tenant. `users.org_id` is NOT NULL post-migration 0029, so a
    // successful login always carries a real org into the access token.
    let org_uuid: Uuid = row
        .try_get("org_id")
        .map_err(|err| RestError::internal(err.to_string()))?;
    let org_id = OrgId::from_uuid(org_uuid);
    let phone: Option<String> = row
        .try_get("phone")
        .map_err(|err| RestError::internal(err.to_string()))?;
    let roles: Vec<String> = row
        .try_get("roles")
        .map_err(|err| RestError::internal(err.to_string()))?;
    let is_active: bool = row
        .try_get("is_active")
        .map_err(|err| RestError::internal(err.to_string()))?;
    if !is_active {
        return Err(RestError::unauthorized("user is inactive"));
    }
    // Every session mint (passkey finish, one-time code, device login, refresh)
    // loads the user here: a SUSPENDED or ARCHIVED tenant gets no session. The
    // platform tier's own row is ARCHIVED by design (0036) and stays exempt.
    // Refused only after proof, so `login/start` never tells the states apart.
    let tenant_status: Option<String> =
        sqlx::query_scalar("SELECT status FROM organizations WHERE id = $1")
            .bind(org_uuid)
            .fetch_optional(tx.as_mut())
            .await
            .map_err(|err| RestError::internal(err.to_string()))?;
    if org_id != OrgId::platform() && tenant_status.as_deref() != Some("ACTIVE") {
        return Err(RestError::tenant_inactive());
    }
    // AX-0 (decision #26): an account with no legacy role signs in; its tenant
    // grants, not a role name, decide what it may do.

    let branch_rows = sqlx::query(
        r#"
        SELECT branch_id
        FROM user_branches
        WHERE user_id = $1
        ORDER BY branch_id
        "#,
    )
    .bind(user_id)
    .fetch_all(tx.as_mut())
    .await
    .map_err(|err| RestError::internal(err.to_string()))?;
    let branches = branch_rows
        .into_iter()
        .map(|row| {
            row.try_get::<Uuid, _>("branch_id")
                .map(BranchId::from_uuid)
                .map_err(|err| RestError::internal(err.to_string()))
        })
        .collect::<Result<Vec<_>, _>>()?;

    let group_role_rows = sqlx::query(
        r#"
        SELECT DISTINCT group_role
        FROM group_role_grants_for_user($1)
        ORDER BY group_role
        "#,
    )
    .bind(user_id)
    .fetch_all(tx.as_mut())
    .await
    .map_err(|err| RestError::internal(err.to_string()))?;
    let group_roles = group_role_rows
        .into_iter()
        .map(|row| {
            row.try_get::<String, _>("group_role")
                .map_err(|err| RestError::internal(err.to_string()))
        })
        .collect::<Result<Vec<_>, _>>()?;

    // Snapshot the subject authorization freshness for the access token
    // (Cedar/PBAC activation, ADR-0021). The `app.current_org` GUC is already
    // armed by the caller, so these RLS-scoped reads only ever see this tenant's
    // rows. An absent row is the "no bump yet" baseline and reads as 0, matching
    // the token default. The shared request boundary validates these versions.
    let subject_versions_row = sqlx::query(
        r#"
        SELECT version, session_generation
        FROM subject_authz_versions
        WHERE user_id = $1
        "#,
    )
    .bind(user_id)
    .fetch_optional(tx.as_mut())
    .await
    .map_err(|err| RestError::internal(err.to_string()))?;
    let (authz_subject_version, session_generation) = match subject_versions_row {
        Some(row) => {
            let version: i64 = row
                .try_get("version")
                .map_err(|err| RestError::internal(err.to_string()))?;
            let session_generation: i64 = row
                .try_get("session_generation")
                .map_err(|err| RestError::internal(err.to_string()))?;
            (
                u64::try_from(version).unwrap_or(0),
                u64::try_from(session_generation).unwrap_or(0),
            )
        }
        None => (0, 0),
    };
    let policy_version: Option<i64> = sqlx::query_scalar(
        r#"
        SELECT version
        FROM policy_versions
        WHERE org_id = $1
        "#,
    )
    .bind(*org_id.as_uuid())
    .fetch_optional(tx.as_mut())
    .await
    .map_err(|err| RestError::internal(err.to_string()))?;
    let authz_policy_version = policy_version
        .map(|version| u64::try_from(version).unwrap_or(0))
        .unwrap_or(0);

    Ok(UserAuthContext {
        user_id: UserId::from_uuid(user_id),
        org_id,
        display_name,
        username: phone.unwrap_or_else(|| user_id.to_string()),
        roles,
        branches,
        group_roles,
        feature_grants: Vec::new(),
        authz_subject_version,
        authz_policy_version,
        session_generation,
    })
}
