use crate::dto::group_admin::GroupAdminGroupResponse;
use crate::dto::group_admin::GroupAdminMemberOrgResponse;
use crate::error::RestError;
use crate::group_admin::actor::GROUP_ADMIN_GROUP_ROLE;
use crate::group_admin::actor::GROUP_ADMIN_TENANT_ACTING_ROLE;
use console_kernel_core::AuditAction;
use console_kernel_core::AuditEvent;
use console_kernel_core::OrgId;
use console_kernel_core::TraceContext;
use console_kernel_core::UserId;
use console_platform_db::with_audit;
use console_platform_group::GroupMemberOrg;
use sqlx::PgPool;
use sqlx::Row;
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug)]
pub(crate) struct GroupIdentity {
    pub(crate) id: Uuid,
    pub(crate) slug: String,
    pub(crate) name: String,
    pub(crate) status: String,
}

pub(crate) async fn load_group_admin_groups(
    pool: &PgPool,
    actor: UserId,
) -> Result<Vec<GroupAdminGroupResponse>, RestError> {
    let group_ids = group_admin_group_ids(pool, actor).await?;
    if group_ids.is_empty() {
        return Err(RestError::forbidden("group admin role required"));
    }

    let group_rows = sqlx::query(
        r#"
        SELECT id, slug, name, status
        FROM groups
        WHERE id = ANY($1)
          AND status = 'ACTIVE'
        ORDER BY name ASC, slug ASC, id ASC
        "#,
    )
    .bind(&group_ids)
    // rls-arming: ok global identity metadata; console_rt has SELECT on safe columns only
    .fetch_all(pool)
    .await
    .map_err(|err| RestError::internal(err.to_string()))?;

    let groups = group_rows
        .into_iter()
        .map(|row| {
            Ok::<_, RestError>(GroupIdentity {
                id: row
                    .try_get("id")
                    .map_err(|err| RestError::internal(err.to_string()))?,
                slug: row
                    .try_get("slug")
                    .map_err(|err| RestError::internal(err.to_string()))?,
                name: row
                    .try_get("name")
                    .map_err(|err| RestError::internal(err.to_string()))?,
                status: row
                    .try_get("status")
                    .map_err(|err| RestError::internal(err.to_string()))?,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;

    let mut responses = Vec::with_capacity(groups.len());
    for group in groups {
        let members = console_platform_group::group_member_orgs(pool, group.id, actor).await?;
        responses.push(GroupAdminGroupResponse {
            id: group.id,
            slug: group.slug,
            name: group.name,
            status: group.status,
            members: members
                .into_iter()
                .map(GroupAdminMemberOrgResponse::from)
                .collect(),
        });
    }

    Ok(responses)
}

pub(crate) async fn group_admin_group_ids(
    pool: &PgPool,
    actor: UserId,
) -> Result<Vec<Uuid>, RestError> {
    sqlx::query_scalar(
        r#"
        SELECT DISTINCT grants.group_id
        FROM group_role_grants_for_user($1) AS grants
            JOIN groups g ON g.id = grants.group_id
        WHERE grants.group_role = $2
          AND g.status = 'ACTIVE'
        ORDER BY grants.group_id
        "#,
    )
    .bind(*actor.as_uuid())
    .bind(GROUP_ADMIN_GROUP_ROLE)
    // rls-arming: ok identity-only SECURITY DEFINER grants resolver + safe groups metadata
    .fetch_all(pool)
    .await
    .map_err(|err| RestError::internal(err.to_string()))
}

pub(crate) async fn resolve_group_admin_target_org(
    pool: &PgPool,
    actor: UserId,
    target_org: OrgId,
) -> Result<(Uuid, GroupMemberOrg), RestError> {
    let group_ids = group_admin_group_ids(pool, actor).await?;
    if group_ids.is_empty() {
        return Err(RestError::forbidden("group admin role required"));
    }

    for group_id in group_ids {
        let members = console_platform_group::group_member_orgs(pool, group_id, actor).await?;
        if let Some(member) = members
            .into_iter()
            .find(|member| member.org_id == target_org)
        {
            return Ok((group_id, member));
        }
    }

    Err(RestError::forbidden(
        "target organization is not a subsidiary managed by this group admin",
    ))
}

pub(crate) async fn record_group_tenant_context_audit(
    pool: &PgPool,
    actor: UserId,
    target_org: OrgId,
    group_id: Uuid,
    action: &str,
    occurred_at: OffsetDateTime,
) -> Result<(), RestError> {
    let event = AuditEvent::new(
        Some(actor),
        AuditAction::new(action).map_err(|err| RestError::internal(err.to_string()))?,
        "organization",
        target_org.to_string(),
        TraceContext::generate(),
        occurred_at,
    )
    .with_org(target_org)
    .with_snapshots(
        None,
        Some(serde_json::json!({
            "group_id": group_id,
            "acting_org_id": target_org.to_string(),
            "acting_role": GROUP_ADMIN_TENANT_ACTING_ROLE,
            "read_only": false,
        })),
    );

    with_audit::<_, (), RestError>(pool, event, |_tx| Box::pin(async move { Ok(()) })).await
}

impl From<GroupMemberOrg> for GroupAdminMemberOrgResponse {
    fn from(value: GroupMemberOrg) -> Self {
        Self {
            id: *value.org_id.as_uuid(),
            slug: value.slug,
            name: value.name,
            status: value.status,
        }
    }
}

// ---------------------------------------------------------------------------
// DB-backed cross-instance rate limiter.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::{load_group_admin_groups, resolve_group_admin_target_org};

    use axum::http::StatusCode;

    use crate::group_admin::actor::has_group_admin_role_hint;
    use console_kernel_core::OrgId;
    use console_kernel_core::UserId;
    use sqlx::PgPool;
    use uuid::Uuid;

    use sqlx::postgres::PgPoolOptions;

    #[test]
    fn group_admin_control_endpoints_require_signed_group_admin_hint() {
        assert!(has_group_admin_role_hint(&["GROUP_ADMIN".to_owned()]));
        assert!(!has_group_admin_role_hint(&[]));
        assert!(!has_group_admin_role_hint(&["GROUP_VIEWER".to_owned()]));
    }

    /// `rate_limit` takes `now` as an explicit parameter (matching the
    /// audit-chain `seal_org_once` precedent), so its window/cap/reset
    /// behavior can be driven with a synthetic clock instead of racing real
    /// wall-clock minute boundaries across a burst of DB round-trips — the
    /// root cause of the flaky HTTP-level `otp_redeem_rate_limit_*` test.
    const ORG_A: Uuid = Uuid::from_u128(0xA013_A013_A013_A013_A013_A013_A013_A013);
    const ORG_B: Uuid = Uuid::from_u128(0xB013_B013_B013_B013_B013_B013_B013_B013);
    const GROUP: Uuid = Uuid::from_u128(0x9013_9013_9013_9013_9013_9013_9013_9013);
    const GROUP_ADMIN: Uuid = Uuid::from_u128(0x1013_1013_1013_1013_1013_1013_1013_1013);
    const GROUP_VIEWER: Uuid = Uuid::from_u128(0x2013_2013_2013_2013_2013_2013_2013_2013);

    async fn runtime_role_pool(owner_pool: &PgPool) -> PgPool {
        let options = owner_pool.connect_options().as_ref().clone();
        PgPoolOptions::new()
            .max_connections(2)
            .after_connect(|conn, _meta| {
                Box::pin(async move {
                    sqlx::query("SET ROLE console_rt").execute(conn).await?;
                    Ok(())
                })
            })
            .connect_with(options)
            .await
            .unwrap()
    }

    async fn seed_group_admin_fixture(pool: &PgPool) {
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("SET LOCAL row_security = off")
            .execute(&mut *tx)
            .await
            .unwrap();

        sqlx::query(
            "INSERT INTO organizations (id, slug, name) VALUES \
                ($1, 'g013-a', 'G013 A'), ($2, 'g013-b', 'G013 B')",
        )
        .bind(ORG_A)
        .bind(ORG_B)
        .execute(&mut *tx)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO users (id, display_name, roles, org_id) VALUES \
                ($1, 'Group Admin', ARRAY['MEMBER'], $3), \
                ($2, 'Group Viewer', ARRAY['MEMBER'], $4)",
        )
        .bind(GROUP_ADMIN)
        .bind(GROUP_VIEWER)
        .bind(ORG_A)
        .bind(ORG_B)
        .execute(&mut *tx)
        .await
        .unwrap();

        sqlx::query("INSERT INTO groups (id, slug, name) VALUES ($1, 'g013', 'G013')")
            .bind(GROUP)
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO group_memberships (group_id, org_id) VALUES ($1, $2), ($1, $3)
             ON CONFLICT (org_id) DO UPDATE SET group_id = EXCLUDED.group_id",
        )
        .bind(GROUP)
        .bind(ORG_A)
        .bind(ORG_B)
        .execute(&mut *tx)
        .await
        .unwrap();
        sqlx::query("UPDATE organizations SET group_id = $1 WHERE id IN ($2, $3)")
            .bind(GROUP)
            .bind(ORG_A)
            .bind(ORG_B)
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO group_role_grants (group_id, user_id, group_role, granted_by) VALUES \
                ($1, $2, 'GROUP_ADMIN', NULL), \
                ($1, $3, 'GROUP_VIEWER', NULL)",
        )
        .bind(GROUP)
        .bind(GROUP_ADMIN)
        .bind(GROUP_VIEWER)
        .execute(&mut *tx)
        .await
        .unwrap();

        tx.commit().await.unwrap();
    }

    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn group_admin_helpers_allow_cross_tenant_subsidiary_but_filter_viewer(
        owner_pool: PgPool,
    ) {
        seed_group_admin_fixture(&owner_pool).await;
        let rt_pool = runtime_role_pool(&owner_pool).await;

        let groups = load_group_admin_groups(&rt_pool, UserId::from_uuid(GROUP_ADMIN))
            .await
            .unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].id, GROUP);
        let member_ids = groups[0]
            .members
            .iter()
            .map(|member| member.id)
            .collect::<Vec<_>>();
        assert_eq!(member_ids, vec![ORG_A, ORG_B]);

        let (_group_id, target) = resolve_group_admin_target_org(
            &rt_pool,
            UserId::from_uuid(GROUP_ADMIN),
            OrgId::from_uuid(ORG_B),
        )
        .await
        .unwrap();
        assert_eq!(
            target.org_id,
            OrgId::from_uuid(ORG_B),
            "a group admin homed in org A can manage subsidiary org B",
        );

        let viewer_error = resolve_group_admin_target_org(
            &rt_pool,
            UserId::from_uuid(GROUP_VIEWER),
            OrgId::from_uuid(ORG_A),
        )
        .await
        .expect_err("GROUP_VIEWER must not manage subsidiaries");
        assert_eq!(viewer_error.status, StatusCode::FORBIDDEN);
    }
}
