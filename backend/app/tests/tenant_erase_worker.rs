// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[path = "../../test_support/governed_erase.rs"]
mod governed_erase;

use console_app::{AppConfig, AppState, install_metrics_recorder, serve};
use console_kernel_core::OrgId;
use console_platform_test_support::seed_org_and_super_admin;
use sqlx::{ConnectOptions, Connection, PgConnection, PgPool, postgres::PgConnectOptions};
use std::time::Duration;

fn serving_url(owner: &PgPool, role: &str, password_env: &str) -> String {
    owner
        .connect_options()
        .as_ref()
        .clone()
        .username(role)
        .password(&std::env::var(password_env).expect("disposable role password is required"))
        .to_url_lossy()
        .to_string()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn worker_from_config_runs_a_due_tenant_erase(owner: PgPool) {
    // Use the adapter's real queue setup so the production worker stays running.
    sqlx::raw_sql(
        "DO $$ BEGIN EXECUTE format('ALTER DATABASE %I OWNER TO console_app', current_database()); END $$",
    )
    .execute(&owner)
    .await
    .unwrap();
    let options: PgConnectOptions = std::env::var("CONSOLE_APALIS_OWNER_DATABASE_URL")
        .expect("disposable migration-owner URL is required")
        .parse()
        .unwrap();
    let mut migration = PgConnection::connect_with(
        &options.database(owner.connect_options().get_database().unwrap()),
    )
    .await
    .unwrap();
    console_platform_jobs::migrate_and_reconcile_apalis_postgres(&mut migration)
        .await
        .unwrap();
    migration.close().await.unwrap();

    let target = OrgId::new();
    let admin = seed_org_and_super_admin(&owner, *target.as_uuid(), "Erase target").await;
    let approver = seed_org_and_super_admin(&owner, *OrgId::platform().as_uuid(), "Approver").await;
    sqlx::query("UPDATE organizations SET status='ARCHIVED' WHERE id=$1")
        .bind(target.as_uuid())
        .execute(&owner)
        .await
        .unwrap();
    governed_erase::due(&owner, *target.as_uuid(), *approver.as_uuid()).await;

    let config = AppConfig::from_pairs([
        ("CONSOLE_APP_ROLE", "worker".to_owned()),
        ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
        (
            "DATABASE_URL",
            serving_url(&owner, "console_rt", "CONSOLE_TEST_RUNTIME_PASSWORD"),
        ),
        (
            "PLATFORM_FORCE_COMMAND_DATABASE_URL",
            serving_url(
                &owner,
                "console_platform_force_cmd",
                "CONSOLE_TEST_FORCE_PASSWORD",
            ),
        ),
    ])
    .unwrap();
    let state = AppState::from_config(config.clone()).await.unwrap();
    let metrics = install_metrics_recorder().unwrap();
    // The first production interval tick is immediate; no test-only scheduler path.
    let erased = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let erased: bool = sqlx::query_scalar(
                "SELECT erased_at IS NOT NULL FROM tenant_erase_requests WHERE target_org_id=$1",
            )
            .bind(target.as_uuid())
            .fetch_one(&owner)
            .await
            .unwrap();
            if erased {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    });
    tokio::select! {
        result = serve(config, state.clone()) => panic!("worker stopped before erasing the due tenant: {result:?}"),
        result = erased => result.expect("the real worker must execute the due tenant erase"),
    }
    state.shutdown_realtime().await;

    let remaining: i64 = sqlx::query_scalar(
        "SELECT (SELECT count(*) FROM organizations WHERE id=$1) + (SELECT count(*) FROM users WHERE id=$2)",
    )
    .bind(target.as_uuid())
    .bind(admin.as_uuid())
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(remaining, 0, "the tenant and its account must be erased");
    let receipts: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM audit_events WHERE action='platform.tenant.erase.run'),
                (SELECT count(*) FROM resource_changes WHERE resource_type='tenant_erase')",
    )
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(
        receipts,
        (1, 1),
        "erase publishes its audit and live receipt"
    );
    assert!(
        metrics
            .render()
            .contains("console_platform_tenant_erase_total{action=\"run\"} 1")
    );
}
