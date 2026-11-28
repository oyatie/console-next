// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{BranchId, Duration, OffsetDateTime, OrgId, PgPool, UserId, Uuid};

pub(super) async fn seed_branch(pool: &PgPool, region_name: &str, branch_name: &str) -> BranchId {
    let region_id: Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1, $2) RETURNING id")
            .bind(region_name)
            .bind(*OrgId::one().as_uuid())
            .fetch_one(pool)
            .await
            .unwrap();
    let branch_id: Uuid = sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(region_id)
    .bind(branch_name)
    .bind(*OrgId::one().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();
    BranchId::from_uuid(branch_id)
}

pub(super) async fn seed_user(pool: &PgPool, user: UserId, branches: &[BranchId]) {
    sqlx::query("INSERT INTO tenant_module_enrollments (org_id,module_key,enabled,change_ref) VALUES ($1,'calendar',true,'test-enrollment') ON CONFLICT DO NOTHING")
        .bind(OrgId::one().as_uuid()).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
        .bind(*user.as_uuid())
        .bind(format!("workbench-{}", user.as_uuid()))
        .bind(vec!["MEMBER"])
        .bind(*OrgId::one().as_uuid())
        .execute(pool)
        .await
        .unwrap();
    for branch in branches {
        sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
            .bind(*user.as_uuid())
            .bind(*branch.as_uuid())
            .bind(*OrgId::one().as_uuid())
            .execute(pool)
            .await
            .unwrap();
    }
}

pub(super) async fn seed_calendar_event(
    pool: &PgPool,
    user: UserId,
    starts_at: OffsetDateTime,
) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO collaboration_calendar_events (\
            id, org_id, scope_type, scope_ref, title, description, starts_at, ends_at, \
            all_day, status, created_by, updated_by, created_at, updated_at\
         ) VALUES (\
            $1, $2, 'PERSONAL', $3, 'native workbench event', '', $4, $5, \
            FALSE, 'ACTIVE', $6, $6, $7, $7\
         )",
    )
    .bind(id)
    .bind(*OrgId::one().as_uuid())
    .bind(user.as_uuid().to_string())
    .bind(starts_at)
    .bind(starts_at + Duration::minutes(30))
    .bind(*user.as_uuid())
    .bind(starts_at)
    .execute(pool)
    .await
    .unwrap();
    id
}
