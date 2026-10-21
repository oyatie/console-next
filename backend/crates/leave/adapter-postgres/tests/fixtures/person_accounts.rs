use super::*;
#[path = "../../../../../test-support/person_fixtures.rs"]
pub(super) mod person_fixtures;
pub(super) async fn seed_user(owner_pool: &PgPool, org: Uuid) -> UserId {
    let user_id = UserId::new();
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, org_id, is_active) \
         VALUES ($1, $2, $3, $4, true)",
    )
    .bind(user_id.as_uuid())
    .bind(format!("User {}", Uuid::new_v4()))
    .bind(vec!["ADMIN".to_string()])
    .bind(org)
    .execute(owner_pool)
    .await
    .unwrap();
    user_id
}

pub(super) async fn link_user_to_branch(
    owner_pool: &PgPool,
    org: Uuid,
    user: UserId,
    branch: Uuid,
) {
    let bound: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM users u JOIN employee_person_bindings b ON b.org_id=u.org_id AND b.employee_id=u.employee_id WHERE u.id=$1)")
        .bind(user.as_uuid()).fetch_one(owner_pool).await.unwrap();
    if !bound {
        person_fixtures::bind_user_to_distinct_person(owner_pool, user).await;
    }
    sqlx::query(
        "INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3) \
         ON CONFLICT DO NOTHING",
    )
    .bind(user.as_uuid())
    .bind(branch)
    .bind(org)
    .execute(owner_pool)
    .await
    .unwrap();
}
