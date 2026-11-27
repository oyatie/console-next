// SPDX-License-Identifier: LicenseRef-Proprietary
//! BG-8 multi-holder company-domain request proofs: shared visibility across
//! both ops holders, optimistic concurrency conflict (`DomainRequestConflict`),
//! and withdrawal (`cancel_company_domain_request`).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[path = "../../access/tests/fixtures/db_clock.rs"]
mod db_clock;

use console_kernel_core::{OrgId, UserId};
use console_platform_provisioning::{PlatformProvisioner, ProvisioningError};
use console_platform_test_support::runtime_role_pool;
use sqlx::PgPool;
use time::Duration;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn multi_holder_domain_requests_share_state_detect_conflicts_and_cancel(owner: PgPool) {
    let rt = runtime_role_pool(&owner).await;
    let p = PlatformProvisioner::new(Duration::minutes(15));
    let now = db_clock::db_now(&owner).await;

    let created = p
        .onboard_tenant(&rt, None, "saeon-initial", "Saeon Corp", now)
        .await
        .unwrap();
    let org = OrgId::from_uuid(created.organization.id);
    let holder1 = UserId::from_uuid(created.admin_user_id);

    // Support both standalone Wave 2 (handoff between ops holders) and Wave 1B+ (two active holders).
    let simultaneous_holders: bool = sqlx::query_scalar(
        "SELECT NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'users_one_tenant_ops')",
    )
    .fetch_one(&owner)
    .await
    .unwrap();
    let holder2_uuid = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users (id, org_id, display_name, roles, is_active, is_tenant_ops)
         VALUES ($1, $2, 'Ops Two', ARRAY['SUPER_ADMIN'], true, $3)",
    )
    .bind(holder2_uuid)
    .bind(org.as_uuid())
    .bind(simultaneous_holders)
    .execute(&owner)
    .await
    .unwrap();
    let holder2 = UserId::from_uuid(holder2_uuid);

    // Holder 1 submits a pending domain change request.
    let submitted = p
        .request_company_domain_checked(
            &rt,
            holder1,
            org,
            "saeon-next",
            Some(None),
            "idem-holder1-submit-0001",
            now,
        )
        .await
        .unwrap();
    assert_eq!(submitted.pending_domain.as_deref(), Some("saeon-next"));
    assert_eq!(submitted.requested_by, Some(*holder1.as_uuid()));

    if !simultaneous_holders {
        let mut tx = owner.begin().await.unwrap();
        sqlx::query("UPDATE users SET is_tenant_ops = false WHERE org_id = $1 AND id = $2")
            .bind(org.as_uuid())
            .bind(holder1.as_uuid())
            .execute(tx.as_mut())
            .await
            .unwrap();
        sqlx::query("UPDATE users SET is_tenant_ops = true WHERE org_id = $1 AND id = $2")
            .bind(org.as_uuid())
            .bind(holder2.as_uuid())
            .execute(tx.as_mut())
            .await
            .unwrap();
        tx.commit().await.unwrap();
    }

    // Holder 2 sees Holder 1's pending request!
    let seen_by_2 = p
        .read_company_domain_state(&rt, holder2, org)
        .await
        .unwrap();
    assert_eq!(seen_by_2.pending_domain.as_deref(), Some("saeon-next"));
    assert_eq!(seen_by_2.requested_by, Some(*holder1.as_uuid()));

    // Stale amendment expecting None fails with DomainRequestConflict.
    let stale = p
        .request_company_domain_checked(
            &rt,
            holder2,
            org,
            "saeon-stale",
            Some(None),
            "idem-holder2-stale-0001",
            now,
        )
        .await
        .unwrap_err();
    assert!(matches!(stale, ProvisioningError::DomainRequestConflict));

    // Informed amendment by Holder 2 expecting Some("saeon-next") succeeds!
    let amended = p
        .request_company_domain_checked(
            &rt,
            holder2,
            org,
            "saeon-amended",
            Some(Some("saeon-next")),
            "idem-holder2-amend-0001",
            now,
        )
        .await
        .unwrap();
    assert_eq!(amended.pending_domain.as_deref(), Some("saeon-amended"));
    assert_eq!(amended.requested_by, Some(*holder2.as_uuid()));

    if !simultaneous_holders {
        let mut tx = owner.begin().await.unwrap();
        sqlx::query("UPDATE users SET is_tenant_ops = false WHERE org_id = $1 AND id = $2")
            .bind(org.as_uuid())
            .bind(holder2.as_uuid())
            .execute(tx.as_mut())
            .await
            .unwrap();
        sqlx::query("UPDATE users SET is_tenant_ops = true WHERE org_id = $1 AND id = $2")
            .bind(org.as_uuid())
            .bind(holder1.as_uuid())
            .execute(tx.as_mut())
            .await
            .unwrap();
        tx.commit().await.unwrap();
    }

    // Holder 1 withdraws the shared pending request.
    let cancelled = p
        .cancel_company_domain_request(&rt, holder1, org, now)
        .await
        .unwrap();
    assert_eq!(cancelled.pending_domain, None);
    assert_eq!(
        p.own_company_domain_request(&rt, holder1, org)
            .await
            .unwrap(),
        None
    );
}
