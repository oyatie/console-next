// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

pub(super) async fn seed_org_actor_customer(owner_pool: &PgPool, org: OrgId) -> BranchId {
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)")
        .bind(*org.as_uuid())
        .bind(format!(
            "consulting-{}",
            &org.as_uuid().simple().to_string()[..12]
        ))
        .bind("Consulting audit integration")
        // rls-arming: ok integration fixture setup runs as the migration owner before runtime-role requests
        .execute(owner_pool)
        .await
        .unwrap();
    let region: Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1, $2) RETURNING id")
            .bind(format!("consulting-audit-region-{}", Uuid::new_v4()))
            .bind(*org.as_uuid())
            // rls-arming: ok integration fixture setup runs as the migration owner before runtime-role requests
            .fetch_one(owner_pool)
            .await
            .unwrap();
    let branch = BranchId::from_uuid(
        sqlx::query_scalar(
            "INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(region)
        .bind(format!("consulting-audit-branch-{}", Uuid::new_v4()))
        .bind(*org.as_uuid())
        // rls-arming: ok integration fixture setup runs as the migration owner before runtime-role requests
        .fetch_one(owner_pool)
        .await
        .unwrap(),
    );
    sqlx::query("INSERT INTO registry_customers (branch_id, name, org_id) VALUES ($1, $2, $3)")
        .bind(*branch.as_uuid())
        .bind("Consulting audit customer")
        .bind(*org.as_uuid())
        // rls-arming: ok integration fixture setup runs as the migration owner before runtime-role requests
        .execute(owner_pool)
        .await
        .unwrap();
    branch
}

pub(super) async fn seed_actor(owner_pool: &PgPool, org: OrgId, branch: BranchId) -> UserId {
    let actor = UserId::new();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
        .bind(*actor.as_uuid())
        .bind("Consulting audit actor")
        .bind(["SUPER_ADMIN"].as_slice())
        .bind(*org.as_uuid())
        // rls-arming: ok integration fixture setup runs as the migration owner before runtime-role requests
        .execute(owner_pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
        .bind(*actor.as_uuid())
        .bind(*branch.as_uuid())
        .bind(*org.as_uuid())
        // rls-arming: ok integration fixture setup runs as the migration owner before runtime-role requests
        .execute(owner_pool)
        .await
        .unwrap();
    let role_id: Uuid = sqlx::query_scalar(
        "INSERT INTO policy_roles \
         (org_id, role_key, display_name, status, is_system, created_by, updated_by) \
         VALUES ($1, $2, $3, 'ACTIVE', false, $4, $4) RETURNING id",
    )
    .bind(*org.as_uuid())
    .bind(format!(
        "consulting_audit_{}",
        &actor.as_uuid().simple().to_string()[..8]
    ))
    .bind("Consulting audit test role")
    .bind(*actor.as_uuid())
    // rls-arming: ok integration fixture setup runs as the migration owner before runtime-role requests
    .fetch_one(owner_pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO policy_role_permissions \
         (org_id, role_id, feature_key, permission_level) \
         VALUES ($1, $2, 'consulting_manage', 'allow')",
    )
    .bind(*org.as_uuid())
    .bind(role_id)
    // rls-arming: ok integration fixture setup runs as the migration owner before runtime-role requests
    .execute(owner_pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO user_role_assignments \
         (org_id, user_id, role_id, assigned_by) VALUES ($1, $2, $3, $2)",
    )
    .bind(*org.as_uuid())
    .bind(*actor.as_uuid())
    .bind(role_id)
    // rls-arming: ok integration fixture setup runs as the migration owner before runtime-role requests
    .execute(owner_pool)
    .await
    .unwrap();
    actor
}
