// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

pub(super) async fn seed_branch(pool: &PgPool, name: &str) -> BranchId {
    let region: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1, $2) RETURNING id")
            .bind(format!("{name} region"))
            .bind(*OrgId::one().as_uuid())
            .fetch_one(pool)
            .await
            .unwrap();
    BranchId::from_uuid(
        sqlx::query_scalar(
            "INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(region)
        .bind(name)
        .bind(*OrgId::one().as_uuid())
        .fetch_one(pool)
        .await
        .unwrap(),
    )
}

pub(super) async fn seed_user(
    pool: &PgPool,
    user_id: UserId,
    role: &str,
    branch: Option<BranchId>,
) {
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
        .bind(*user_id.as_uuid())
        .bind(format!("catalog {role}"))
        .bind(vec![role])
        .bind(*OrgId::one().as_uuid())
        .execute(pool)
        .await
        .unwrap();
    if let Some(branch) = branch {
        sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
            .bind(*user_id.as_uuid())
            .bind(*branch.as_uuid())
            .bind(*OrgId::one().as_uuid())
            .execute(pool)
            .await
            .unwrap();
    }
    // The tokens stamp subject freshness 1 (the row's defaults); the live row
    // must exist at mint, as a sign-in would read it.
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(OrgId::one().as_uuid().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("INSERT INTO subject_authz_versions (org_id, user_id) VALUES ($1, $2)")
        .bind(*OrgId::one().as_uuid())
        .bind(*user_id.as_uuid())
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

pub(super) async fn audit_count(pool: &PgPool, action: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE action = $1")
        .bind(action)
        .fetch_one(pool)
        .await
        .unwrap()
}

pub(super) async fn seed_site(pool: &PgPool, branch: BranchId) -> uuid::Uuid {
    let org = OrgId::one();
    let customer:uuid::Uuid=sqlx::query_scalar("INSERT INTO registry_customers(branch_id,name,org_id) VALUES ($1,'Synthetic catalog customer',$2) RETURNING id")
        .bind(branch.as_uuid()).bind(org.as_uuid()).fetch_one(pool).await.unwrap();
    sqlx::query_scalar("INSERT INTO registry_sites(branch_id,customer_id,name,org_id) VALUES ($1,$2,'Synthetic catalog site',$3) RETURNING id")
        .bind(branch.as_uuid()).bind(customer).bind(org.as_uuid()).fetch_one(pool).await.unwrap()
}
