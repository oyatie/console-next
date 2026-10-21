use super::*;
#[path = "../../../../../test-support/person_fixtures.rs"]
mod person_fixtures;
pub(super) async fn seed_user(
    pool: &PgPool,
    org: OrgId,
    role: &str,
    employee: Option<Uuid>,
) -> UserId {
    let user = UserId::new();
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, is_active, org_id, employee_id) \
         VALUES ($1, $2, $3, true, $4, $5)",
    )
    .bind(*user.as_uuid())
    .bind(format!("payroll-{role}-{user}"))
    .bind(vec![role.to_owned()])
    .bind(*org.as_uuid())
    .bind(employee)
    .execute(pool)
    .await
    .unwrap();
    person_fixtures::bind_user_to_distinct_person(pool, user).await;
    user
}
