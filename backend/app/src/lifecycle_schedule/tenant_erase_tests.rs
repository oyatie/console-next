// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_platform_test_support::governed_erase;

use console_kernel_core::OrgId;
use console_platform_provisioning::PlatformProvisioner;
use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use sqlx::{PgPool, postgres::PgPoolOptions};
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn idle_worker_recovers_distinct_organizations_with_the_same_ledger_sequence(owner: PgPool) {
    let force = PgPoolOptions::new()
        .max_connections(2)
        .after_connect(|conn, _| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_platform_force_cmd")
                    .execute(conn)
                    .await?;
                Ok(())
            })
        })
        .connect_with(owner.connect_options().as_ref().clone())
        .await
        .unwrap();
    let approver = seed_org_and_super_admin(&owner, *OrgId::platform().as_uuid(), "witness").await;
    let rt = runtime_role_pool(&owner).await;
    let receipt_count = || {
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM tenant_erase_witness_emissions")
            .fetch_one(&owner)
    };
    let subscriber = || {
        tracing_subscriber::fmt()
            .with_writer(std::io::sink)
            .finish()
    };
    let mut organizations = Vec::new();
    for label in ["witness-a", "witness-b"] {
        let org: Uuid = sqlx::query_scalar("INSERT INTO organizations (slug, name, status) VALUES ($1, $1, 'ARCHIVED') RETURNING id")
            .bind(label).fetch_one(&owner).await.unwrap();
        governed_erase::due(&owner, org, *approver.as_uuid()).await;
        assert_eq!(
            PlatformProvisioner::run_due_tenant_erases(&force)
                .await
                .unwrap(),
            1
        );
        if organizations.is_empty() {
            let _guard = tracing::subscriber::set_default(subscriber());
            super::run_tenant_erase_tick(&rt, Some(&force)).await;
            assert_eq!(receipt_count().await.unwrap(), 1);
        }
        organizations.push(org);
    }
    let ledger: Vec<(Uuid, i64)> = sqlx::query_as(
        "SELECT org_id, seq FROM erasure_ledger WHERE org_id = ANY($1) ORDER BY org_id",
    )
    .bind(&organizations)
    .fetch_all(&owner)
    .await
    .unwrap();
    organizations.sort();
    assert_eq!(ledger, [(organizations[0], 1), (organizations[1], 1)]);
    assert_eq!(
        PlatformProvisioner::run_due_tenant_erases(&force)
            .await
            .unwrap(),
        0
    );

    {
        let _off = tracing::subscriber::set_default(tracing::subscriber::NoSubscriber::default());
        super::run_tenant_erase_tick(&rt, Some(&force)).await;
        assert_eq!(receipt_count().await.unwrap(), 1);
    }
    // A restarted worker can emit pending receipts without force credentials.
    let _guard = tracing::subscriber::set_default(subscriber());
    let restarted = runtime_role_pool(&owner).await;
    super::run_tenant_erase_tick(&restarted, None).await;
    assert_eq!(receipt_count().await.unwrap(), 2);
    assert_eq!(
        PlatformProvisioner::emit_pending_erase_witnesses(&restarted)
            .await
            .unwrap(),
        0
    );
}
