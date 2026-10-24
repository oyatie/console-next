// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
#[path = "../../../../../test-support/person_fixtures.rs"]
mod person_fixtures;

pub(super) async fn seed_user(owner: &PgPool, org: Uuid) -> UserId {
    let user_id = UserId::new();
    let event = console_kernel_core::AuditEvent::new(
        None,
        console_kernel_core::AuditAction::new("test.seed_user").unwrap(),
        "user",
        user_id.as_uuid().to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(OrgId::from_uuid(org));
    with_audit(owner, event, |tx| {
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)",
            )
            .bind(*user_id.as_uuid())
            .bind("Admin replay")
            .bind(["SUPER_ADMIN"].as_slice())
            .bind(org)
            .execute(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;
            Ok::<(), DbError>(())
        })
    })
    .await
    .unwrap();
    person_fixtures::bind_user_to_distinct_person(owner, user_id).await;
    user_id
}
