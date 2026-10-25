// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_identity_application::TenantFactsRead;
use console_kernel_core::{OrgId, TenantPhase};
use console_onboarding_adapter_postgres::PgOnboardingStore;
use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn missing_phase_uses_the_shared_operating_fallback_and_no_copied_name(owner: PgPool) {
    let org = OrgId::new();
    seed_org_and_super_admin(&owner, *org.as_uuid(), "tenant-facts").await;
    let store = PgOnboardingStore::new(runtime_role_pool(&owner).await);
    assert_eq!(
        store.read_tenant(org).await.unwrap().phase,
        TenantPhase::Setup
    );
    sqlx::query("DELETE FROM tenant_phase WHERE org_id = $1")
        .bind(org.as_uuid())
        .execute(&owner)
        .await
        .unwrap();
    let facts = store.read_tenant(org).await.unwrap();
    assert_eq!(facts.phase, TenantPhase::Operating);
    assert!(facts.go_live_at.is_none());
    let name: String = sqlx::query_scalar("SELECT name FROM organizations WHERE id = $1")
        .bind(org.as_uuid())
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(facts.name, name);
}
