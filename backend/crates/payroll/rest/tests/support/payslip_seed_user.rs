// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

pub(super) async fn seed_user(owner_pool: &PgPool, user_id: UserId, org: Uuid, role: &str) {
    let role = role.to_owned();
    with_audit(
        owner_pool,
        seed_event("test.seed_user", "user", *user_id.as_uuid(), org),
        |tx| {
            Box::pin(async move {
                sqlx::query(
                    "INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)",
                )
                .bind(*user_id.as_uuid())
                .bind(format!("user-{role}-{}", user_id.as_uuid()))
                .bind(vec![role])
                .bind(org)
                .execute(tx.as_mut())
                .await
                .map_err(DbError::Sqlx)?;
                Ok::<(), DbError>(())
            })
        },
    )
    .await
    .unwrap();
}
