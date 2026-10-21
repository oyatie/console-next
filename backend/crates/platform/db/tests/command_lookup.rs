#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Operation IDs win over user-supplied keys that happen to equal them.
#[allow(dead_code)] // The shared fixture also serves the transactional ledger suite.
#[path = "command_ledger_support/mod.rs"]
mod support;
use console_kernel_core::UserId;
use console_platform_db::command_outcomes;
use sqlx::PgPool;
use support::Fixture;
static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[sqlx::test(migrator = "MIGRATOR")]
async fn operation_id_lookup_cannot_be_shadowed_by_another_request_key(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let original = f.fresh("original-ledger-request").await;
    let shadow = f.fresh(&original.to_string()).await;
    assert_ne!(original, shadow);
    for viewer in [f.actor, UserId::new()] {
        let found = command_outcomes::lookup(&f.rt, f.org, viewer, original.to_string())
            .await
            .unwrap()
            .expect("exact ID must remain discoverable");
        assert_eq!(found.id, original);
    }
    assert_eq!(f.domain_count().await, 0);
    assert_eq!(f.audit_count(original, "command.received").await, 1);
    assert_eq!(f.audit_count(shadow, "command.received").await, 1);
}
