// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

pub(super) async fn seed_employee(pool: &PgPool, org: Uuid, source_key: &str) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO employees \
         (org_id, company, name, source_filename, source_sheet, source_row, source_key, identity_review_required) \
         VALUES ($1, 'ACME', $2, 'seed.xlsx', 'Sheet1', 1, $2, false) RETURNING id",
    )
    .bind(org)
    .bind(source_key)
    .fetch_one(pool)
    .await
    .unwrap()
}

pub(super) async fn seed_person_bound_user(
    pool: &PgPool,
    org: Uuid,
    name: &str,
    employee_id: Uuid,
    person_id: Uuid,
    binder: UserId,
) -> UserId {
    let user = seed_unbound_user(pool, org, name).await;
    sqlx::query(
        "INSERT INTO employee_person_bindings \
         (org_id, employee_id, person_id, actor_id, payload_digest) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(org)
    .bind(employee_id)
    .bind(person_id)
    .bind(*binder.as_uuid())
    .bind([7_u8; 32].as_slice())
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("UPDATE users SET employee_id = $1 WHERE id = $2 AND org_id = $3")
        .bind(employee_id)
        .bind(*user.as_uuid())
        .bind(org)
        .execute(pool)
        .await
        .unwrap();
    user
}

pub(super) async fn seed_person(pool: &PgPool, org: Uuid) -> Uuid {
    sqlx::query_scalar("INSERT INTO persons (org_id) VALUES ($1) RETURNING id")
        .bind(org)
        .fetch_one(pool)
        .await
        .unwrap()
}
