use super::*;
use console_kernel_core::Timestamp;
use sqlx::{Postgres, Transaction};

/// Validate current authority at the request boundary.
pub async fn validate_current_claims(
    pool: &PgPool,
    claims: &AccessClaims,
) -> Result<(UserId, OrgId), RequestContextError> {
    let mut tx = pool.begin().await.map_err(authority_unavailable)?;
    let (user, org, activity) = validate_in_tx(&mut tx, claims).await?;
    tx.commit().await.map_err(authority_unavailable)?;
    crate::idle::write_back(pool, activity).await;
    Ok((user, org))
}

fn authority_unavailable(error: sqlx::Error) -> RequestContextError {
    let error = console_platform_db::DbError::begin(error);
    RequestContextError::EffectivePolicy(format!("current account authority unavailable: {error}"))
}

/// Validate a verified token against its current account and Company authority.
/// This is authentication at the request boundary; domain owners must still
/// check current policy and revisions inside consequential transactions.
/// The caller's transaction holds the family row, so its activity is checked
/// but not written back here.
pub async fn validate_current_claims_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    claims: &AccessClaims,
) -> Result<(UserId, OrgId), RequestContextError> {
    let (user, org, _) = validate_in_tx(tx, claims).await?;
    Ok((user, org))
}

async fn validate_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    claims: &AccessClaims,
) -> Result<(UserId, OrgId, Option<crate::idle::WriteBack>), RequestContextError> {
    let user = UserId::from_str(&claims.sub).map_err(|_| RequestContextError::InvalidToken)?;
    let target = OrgId::from_str(&claims.org).map_err(|_| RequestContextError::InvalidToken)?;
    let roles = claims
        .roles
        .iter()
        .map(|role| Role::from_str(role))
        .collect::<Result<BTreeSet<_>, _>>()
        .map_err(|_| RequestContextError::InvalidToken)?;
    // AX-0 (decision #26): no legacy role is still a session; grants decide.
    if claims.platform != (target == OrgId::platform()) {
        return Err(RequestContextError::InvalidToken);
    }
    let delegated = claims.actor_session.is_some();
    let session = match claims.actor_session {
        Some(session) if !claims.platform && claims.session_family_id.is_none() => {
            match claims.tenant_context {
                Some(TenantAccessContext::GroupAdmin) => {
                    if session.home_org == OrgId::platform()
                        || claims.actor_home_org.as_deref()
                            != Some(session.home_org.to_string().as_str())
                    {
                        return Err(RequestContextError::InvalidToken);
                    }
                }
                None => {
                    if session.home_org != OrgId::platform()
                        || claims.support.is_none()
                        || !claims.read_only
                        || !roles.is_empty()
                        || !claims.group_roles.is_empty()
                    {
                        return Err(RequestContextError::InvalidToken);
                    }
                }
            }
            session
        }
        None if claims.tenant_context.is_none()
            && claims.support.is_none()
            && !claims.read_only =>
        {
            ActorSession {
                family_id: claims
                    .session_family_id
                    .ok_or(RequestContextError::InvalidToken)?,
                expires_at: claims.exp,
                home_org: target,
                subject_version: claims.authz_subject_version,
                session_generation: claims.session_generation,
            }
        }
        _ => return Err(RequestContextError::InvalidToken),
    };
    if claims.platform && !PlatformPrincipal::accepts_roles(&claims.roles) {
        return Err(RequestContextError::InvalidToken);
    }
    let home = session.home_org;
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(home.to_string())
        .execute(tx.as_mut())
        .await
        .map_err(authority_unavailable)?;
    if console_platform_auth::lock_account_tx(tx, home, *user.as_uuid())
        .await
        .map_err(authority_unavailable)?
        != Some(true)
    {
        return Err(RequestContextError::InvalidToken);
    }
    // Hold existing freshness rows against revocation until the protected read commits.
    sqlx::query(
        "SELECT user_id FROM subject_authz_versions WHERE org_id=$1 AND user_id=$2 FOR SHARE",
    )
    .bind(home.as_uuid())
    .bind(user.as_uuid())
    .fetch_optional(tx.as_mut())
    .await
    .map_err(authority_unavailable)?;
    type Row = (
        bool,
        Vec<String>,
        String,
        i64,
        i64,
        Timestamp,
        Option<i32>,
        Timestamp,
        bool,
    );
    let row = sqlx::query_as::<_, Row>(
            "SELECT u.is_active, u.roles, o.status, COALESCE(v.version,0), COALESCE(v.session_generation,0), \
                    f.last_activity_at, f.idle_timeout_minutes, clock_timestamp(), \
                    f.session_purpose IS NOT DISTINCT FROM 'enrollment' \
                    OR EXISTS (SELECT 1 FROM auth_legacy_otp_family_sources s WHERE s.family_id=f.id) \
             FROM users u JOIN organizations o ON o.id=u.org_id \
             JOIN auth_refresh_token_families f ON f.user_id=u.id AND f.org_id=u.org_id AND f.id=$3 AND f.revoked_at IS NULL \
             LEFT JOIN subject_authz_versions v ON v.org_id=u.org_id AND v.user_id=u.id \
             WHERE u.id=$1 AND u.org_id=$2 FOR SHARE OF u, f")
            .bind(*user.as_uuid()).bind(*home.as_uuid()).bind(session.family_id).fetch_optional(tx.as_mut()).await.map_err(authority_unavailable)?
        .ok_or(RequestContextError::InvalidToken)?;
    let (
        active,
        live_roles,
        status,
        subject_version,
        session_generation,
        seen,
        snapshot,
        now,
        otp_family,
    ) = row;
    // An OTP-bound family mints only enrollment tokens and nothing else does:
    // a token whose marker disagrees with its family (a pre-marker OTP token,
    // or a delegation sourced from an enrollment session) is not a session.
    if !active
        || otp_family != claims.enrollment
        || (delegated && claims.enrollment)
        || (home != OrgId::platform() && status != "ACTIVE")
        || u64::try_from(subject_version).ok() != Some(session.subject_version)
        || u64::try_from(session_generation).ok() != Some(session.session_generation)
        || (!delegated && claims.roles.iter().any(|role| !live_roles.contains(role)))
        || (home == OrgId::platform() && !PlatformPrincipal::accepts_roles(&live_roles))
    {
        return Err(RequestContextError::InvalidToken);
    }
    let write_back = crate::idle::check(tx, home, session.family_id, (seen, snapshot, now)).await?;
    if target != home {
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(target.to_string())
            .execute(tx.as_mut())
            .await
            .map_err(authority_unavailable)?;
        let active =
            sqlx::query_scalar::<_, bool>("SELECT status='ACTIVE' FROM organizations WHERE id=$1")
                .bind(target.as_uuid())
                .fetch_optional(tx.as_mut())
                .await
                .map_err(authority_unavailable)?;
        if active != Some(true) {
            return Err(RequestContextError::InvalidToken);
        }
    }
    claims
        .validate_expiry()
        .map_err(|_| RequestContextError::InvalidToken)?;
    Ok((user, target, write_back))
}
