// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_kernel_core::OrgId;
use console_orgchange_adapter_postgres::PgOrgChangeStore;
use console_platform_test_support::runtime_role_pool;
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn legacy_legal_name_cannot_replace_the_tenant_root_or_its_history(owner: PgPool) {
    let org = OrgId::new();
    let actor = console_platform_test_support::seed_org_and_super_admin(
        &owner,
        *org.as_uuid(),
        "tenant-display",
    )
    .await;
    // Seed an N-1 row while expansion retains its insert privilege.
    sqlx::query("INSERT INTO company_revisions (org_id, version, command_id, actor_id, payload_digest, attributes, receipt) VALUES ($1,1,gen_random_uuid(),$2,sha256('x'::bytea),'{\"legal_name\":\"COSS\"}','{}')")
        .bind(org.as_uuid()).bind(actor.as_uuid()).execute(&owner).await.unwrap();
    let store = PgOrgChangeStore::new(runtime_role_pool(&owner).await);
    console_platform_request_context::scope_org(org, async {
        let tree = store.list_org_units().await.unwrap();
        assert_eq!(tree.items[0].name, "Org tenant-display");
        let root = store.get_org_unit(*org.as_uuid()).await.unwrap();
        assert_eq!(root.head.name, "Org tenant-display");
        assert!(
            root.revisions.is_empty(),
            "legal history is on the entity, never on the tenant"
        );
    })
    .await;
}
