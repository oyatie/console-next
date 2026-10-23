// SPDX-License-Identifier: LicenseRef-Proprietary
//! Governed sole-admin elevation. Pending grants neither authorize nor count.
use console_identity_adapter_postgres::second_person::{HolderCapability, PgHolderResolver};
use console_kernel_core::{
    AuditAction, AuditEvent, Clock, OrgId, TenantPhase, TraceContext, UserId,
};
use console_platform_authz::access::{
    AccessSlice, Domain, Level, action_group, load_access_subject, load_tenant_phase,
};
use console_settings_adapter_postgres::resolve_in_tx;
use console_settings_domain::SettingKey;
use sqlx::{PgPool, Postgres, Row, Transaction};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::{AccessError, AccessResult, actor::node_path};

#[cfg(test)]
pub(crate) async fn deadline(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    role: Uuid,
    clock: &dyn Clock,
) -> AccessResult<Option<OffsetDateTime>> {
    let (_, version) = crate::grants_store::role_head(tx, org, role)
        .await?
        .ok_or_else(|| AccessError::not_found("role_not_found", "no such role"))?;
    let lines = crate::roles_store::lines_of(tx, org, role, version).await?;
    deadline_for_lines(tx, org, &lines, clock).await
}

pub(crate) async fn deadline_for_lines(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    lines: &[crate::LineOut],
    clock: &dyn Clock,
) -> AccessResult<Option<OffsetDateTime>> {
    if !lines
        .iter()
        .any(|l| l.levels.iter().any(|level| *level != Level::View))
    {
        return Ok(None);
    }
    sole_admin_deadline(tx, org, clock).await
}

pub(crate) async fn sole_admin_deadline(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    clock: &dyn Clock,
) -> AccessResult<Option<OffsetDateTime>> {
    if load_tenant_phase(tx, org).await? == TenantPhase::Setup {
        return Ok(None);
    }
    let now = clock.now();
    let holders = PgHolderResolver {
        tx,
        org,
        capability: HolderCapability::AccessAdmin,
        exclude_account: None,
        exclude_employee: None,
        include_ops: true,
        now,
    }
    .resolve_at_most(2)
    .await?;
    if holders.len() > 1 {
        return Ok(None);
    }
    let key = SettingKey::AuthzElevatedGrantSoleAdminDelay;
    let settings = resolve_in_tx(tx.as_mut(), org, &[key], None, now).await?;
    let hours = settings
        .get(&key)
        .and_then(|v| v.as_ref().ok())
        .and_then(|v| v.value.as_int())
        .ok_or_else(|| AccessError::internal("sole-admin grant delay unavailable"))?;
    Ok(Some(now + Duration::hours(hours)))
}

/// Recheck the live grantor, target, role, dates and last-ops invariant in the
/// activation transaction. The clock port makes boundary proofs deterministic.
pub async fn activate_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    grant: Uuid,
    clock: &dyn Clock,
) -> AccessResult<()> {
    let now = clock.now();
    let pending = sqlx::query(
        "SELECT activates_at, activated_at FROM user_role_grants_pending WHERE org_id=$1 AND grant_id=$2 FOR UPDATE")
        .bind(org.as_uuid()).bind(grant).fetch_optional(tx.as_mut()).await?
        .ok_or_else(|| AccessError::not_found("grant_not_found", "no pending grant"))?;
    let row = sqlx::query(
        "SELECT g.account_id, g.granted_by, g.role_id, g.status, g.valid_to, r.status AS role_status,
                u.is_active AS target_active
           FROM access_grants g JOIN access_roles r ON r.org_id=g.org_id AND r.id=g.role_id
           JOIN users u ON u.org_id=g.org_id AND u.id=g.account_id
          WHERE g.org_id=$1 AND g.id=$2 FOR UPDATE OF g FOR SHARE OF r, u")
        .bind(org.as_uuid()).bind(grant).fetch_one(tx.as_mut()).await?;
    if row.try_get::<String, _>("status")? == "REVOKED"
        || row
            .try_get::<Option<OffsetDateTime>, _>("valid_to")?
            .is_some_and(|to| to <= now)
        || row.try_get::<String, _>("role_status")? != "ACTIVE"
        || !row.try_get::<bool, _>("target_active")?
    {
        return Err(AccessError::conflict(
            "grant_ended",
            "종료되거나 비활성화된 권한은 적용할 수 없습니다",
        ));
    }
    if pending
        .try_get::<Option<OffsetDateTime>, _>("activated_at")?
        .is_some()
    {
        return Ok(());
    }
    if now < pending.try_get::<OffsetDateTime, _>("activates_at")? {
        return Err(AccessError::conflict(
            "pending_grant_not_due",
            "권한 적용 대기 시간이 지나지 않았습니다",
        ));
    }
    // Lock the surviving ops account: handover/deactivation cannot race this recheck.
    let ops: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM users WHERE org_id=$1 AND is_tenant_ops AND is_active FOR SHARE",
    )
    .bind(org.as_uuid())
    .fetch_optional(tx.as_mut())
    .await?;
    if ops.is_none() {
        return Err(AccessError::access_denied());
    }
    let by: Uuid = row.try_get("granted_by")?;
    let active: bool =
        sqlx::query_scalar("SELECT is_active FROM users WHERE org_id=$1 AND id=$2 FOR SHARE")
            .bind(org.as_uuid())
            .bind(by)
            .fetch_one(tx.as_mut())
            .await?;
    if !active {
        return Err(AccessError::access_denied());
    }
    let grant_row = crate::grants_store::grant_row(tx, org, grant, false)
        .await?
        .ok_or_else(|| AccessError::not_found("grant_not_found", "no such grant"))?;
    let path = node_path(tx, org, grant_row.kind, grant_row.node_id).await?;
    crate::actor::refuse_closed(tx, org, &path).await?;
    let subject = load_access_subject(tx, org, by, now).await?;
    let slice = AccessSlice::compile(&subject).map_err(AccessError::internal)?;
    let (_, version) = crate::grants_store::role_head(tx, org, grant_row.role_id)
        .await?
        .ok_or_else(|| AccessError::not_found("role_not_found", "no such role"))?;
    let lines = crate::roles_store::lines_of(tx, org, grant_row.role_id, version).await?;
    for line in lines {
        for level in line.levels {
            if !slice
                .allows(&action_group(line.domain, level), &path)
                .unwrap_or(false)
            {
                return Err(AccessError::forbidden(
                    "grant_exceeds_grantor",
                    "부여자의 현재 권한을 넘는 권한은 적용할 수 없습니다",
                ));
            }
        }
    }
    if !slice
        .allows(&action_group(Domain::Access, Level::Edit), &path)
        .unwrap_or(false)
    {
        return Err(AccessError::access_denied());
    }
    sqlx::query(
        "UPDATE access_grants SET status='ACTIVE' WHERE org_id=$1 AND id=$2 AND status='PENDING'",
    )
    .bind(org.as_uuid())
    .bind(grant)
    .execute(tx.as_mut())
    .await?;
    sqlx::query(
        "UPDATE user_role_grants_pending SET activated_at=$3 WHERE org_id=$1 AND grant_id=$2",
    )
    .bind(org.as_uuid())
    .bind(grant)
    .bind(now)
    .execute(tx.as_mut())
    .await?;
    event(tx, org, grant, by, "access.grant.activated", now).await
}

pub(crate) async fn event(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    grant: Uuid,
    by: Uuid,
    action: &str,
    at: OffsetDateTime,
) -> AccessResult<()> {
    let event = AuditEvent::new(
        Some(UserId::from_uuid(by)),
        AuditAction::new(action)?,
        "access_grant",
        grant.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org)
    .with_snapshots(
        None,
        Some(serde_json::json!({"activates_at": at.to_string()})),
    );
    console_platform_db::insert_audit_event(tx, &event)
        .await
        .map_err(AccessError::internal)?;
    tracing::info!(business_event=action, %org, %grant, "elevated grant transition");
    Ok(())
}

/// Replica-safe scheduler pass. Discovery is id-only; all writes are tenant armed.
pub async fn activate_due(pool: &PgPool, clock: &dyn Clock) -> AccessResult<usize> {
    let orgs: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM platform_list_organizations()")
        // rls-arming: ok id-only discovery; each write runs in with_org_conn below.
        .fetch_all(pool)
        .await?;
    let mut activated = 0;
    for id in orgs {
        let org = OrgId::from_uuid(id);
        let now = activation_clock(id, clock.now()).await;
        let result = console_platform_db::with_org_conn::<_, _, AccessError>(pool, org, move |tx| {
            Box::pin(async move {
                let ids: Vec<Uuid> = sqlx::query_scalar(
                    "SELECT p.grant_id FROM user_role_grants_pending p JOIN access_grants g ON g.org_id=p.org_id AND g.id=p.grant_id
                      WHERE p.org_id=$1 AND p.activated_at IS NULL AND p.activates_at <= $2 AND g.status='PENDING'
                      ORDER BY p.activates_at, p.grant_id FOR UPDATE OF p SKIP LOCKED")
                    .bind(org.as_uuid()).bind(now).fetch_all(tx.as_mut()).await?;
                let mut count = 0;
                for grant in ids {
                    match activate_in_tx(tx, org, grant, &console_kernel_core::FixedClock(now)).await {
                        Ok(()) => count += 1,
                        Err(e) if e.is_refusal() => tracing::warn!(%org, %grant, code=e.code, "pending grant refused; remains pending"),
                        Err(e) => return Err(e),
                    }
                }
                Ok(count)
            })
        }).await;
        match result {
            Ok(count) => activated += count,
            Err(e) => tracing::error!(%org, ?e, "pending grant activation failed; retry next tick"),
        }
    }
    Ok(activated)
}

/// Tenant-scoped test time; release builds never read a clock override.
#[cfg(debug_assertions)]
async fn activation_clock(org: Uuid, real: OffsetDateTime) -> OffsetDateTime {
    let Some(path) = std::env::var_os("CONSOLE_DEV_LIFECYCLE_TODAY_FILE") else {
        return real;
    };
    let mut directory = path;
    directory.push(".grants");
    let raw = tokio::fs::read_to_string(std::path::PathBuf::from(directory).join(org.to_string()))
        .await
        .ok();
    effective_activation_time(real, raw.as_deref())
}

#[cfg(debug_assertions)]
fn effective_activation_time(real: OffsetDateTime, raw: Option<&str>) -> OffsetDateTime {
    raw.and_then(|s| {
        OffsetDateTime::parse(s.trim(), &time::format_description::well_known::Rfc3339).ok()
    })
    .map_or(real, |at| at.max(real))
}

#[cfg(not(debug_assertions))]
async fn activation_clock(_org: Uuid, real: OffsetDateTime) -> OffsetDateTime {
    real
}

#[cfg(all(test, debug_assertions))]
mod tests {
    use super::effective_activation_time;
    use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};

    #[test]
    fn debug_clock_rejects_invalid_time_and_never_moves_backwards() {
        let now = OffsetDateTime::now_utc();
        assert_eq!(effective_activation_time(now, None), now);
        assert_eq!(effective_activation_time(now, Some("not a clock")), now);
        let past = (now - Duration::days(1)).format(&Rfc3339).unwrap();
        assert_eq!(effective_activation_time(now, Some(&past)), now);
        let future = now + Duration::days(1);
        assert_eq!(
            effective_activation_time(now, Some(&future.format(&Rfc3339).unwrap())),
            future
        );
    }
}
