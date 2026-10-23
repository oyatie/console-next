use console_kernel_core::UserId;
use sqlx::PgPool;
use uuid::Uuid;

/// Bind an existing account to a new natural person as the fixture owner.
#[allow(dead_code)]
pub async fn bind_user_to_distinct_person(owner: &PgPool, user: UserId) -> (Uuid, Uuid) {
    let org: Uuid = sqlx::query_scalar("SELECT org_id FROM users WHERE id = $1")
        .bind(*user.as_uuid())
        .fetch_one(owner)
        .await
        .unwrap();
    let person = sqlx::query_scalar("INSERT INTO persons (org_id) VALUES ($1) RETURNING id")
        .bind(org)
        .fetch_one(owner)
        .await
        .unwrap();
    (bind_user_to_person(owner, user, person).await, person)
}

/// Preserve the employee link and explicitly replace its fixture person binding.
pub async fn bind_user_to_person(owner: &PgPool, user: UserId, person: Uuid) -> Uuid {
    let (org, linked): (Uuid, Option<Uuid>) =
        sqlx::query_as("SELECT org_id, employee_id FROM users WHERE id = $1")
            .bind(*user.as_uuid())
            .fetch_one(owner)
            .await
            .unwrap();
    let employee = match linked {
        Some(employee) => employee,
        None => sqlx::query_scalar(
            "INSERT INTO employees \
                 (org_id, company, name, source_filename, source_sheet, source_row, source_key) \
                 VALUES ($1, 'ACME', $2, 'person-fixture.xlsx', 'People', 1, $2) RETURNING id",
        )
        .bind(org)
        .bind(format!("person-fixture-{user}"))
        .fetch_one(owner)
        .await
        .unwrap(),
    };
    sqlx::query("DELETE FROM employee_person_bindings WHERE org_id = $1 AND employee_id = $2")
        .bind(org)
        .bind(employee)
        .execute(owner)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO employee_person_bindings \
         (org_id, employee_id, person_id, actor_id, payload_digest) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(org)
    .bind(employee)
    .bind(person)
    .bind(*user.as_uuid())
    .bind([7_u8; 32].as_slice())
    .execute(owner)
    .await
    .unwrap();
    sqlx::query("UPDATE users SET employee_id = $1 WHERE id = $2 AND org_id = $3")
        .bind(employee)
        .bind(*user.as_uuid())
        .bind(org)
        .execute(owner)
        .await
        .unwrap();
    employee
}
