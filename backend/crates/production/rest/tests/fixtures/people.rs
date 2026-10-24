// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
#[path = "../../../../../test-support/person_fixtures.rs"]
mod person_fixtures;

pub(super) async fn seed_user(
    pool: &PgPool,
    org: OrgId,
    branch: BranchId,
    role: &str,
    name: &str,
) -> UserId {
    let user = UserId::new();
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, org_id, is_active) VALUES ($1,$2,$3,$4,true)",
    )
    .bind(*user.as_uuid())
    .bind(name)
    .bind(vec![role.to_owned()])
    .bind(*org.as_uuid())
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1,$2,$3)")
        .bind(*user.as_uuid())
        .bind(*branch.as_uuid())
        .bind(*org.as_uuid())
        .execute(pool)
        .await
        .unwrap();
    person_fixtures::bind_user_to_distinct_person(pool, user).await;
    user
}
