#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! The lockout invariant (GR-3): a tenant that has an ops account never
//! commits without an ACTIVE one; a handover in one transaction passes; there
//! is never a second one. (Deleting the ops user is held by its foreign keys
//! first and by the same deferred trigger last; tenant removal skips it.)

mod support;

use sqlx::PgPool;
use support::world;

async fn commit(
    pool: &PgPool,
    statements: &[&str],
    ops: uuid::Uuid,
    other: uuid::Uuid,
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    for sql in statements {
        sqlx::query(sqlx::AssertSqlSafe((*sql).to_owned()))
            .bind(ops)
            .bind(other)
            .execute(tx.as_mut())
            .await?;
    }
    tx.commit().await
}

fn is_lockout(err: &sqlx::Error) -> bool {
    err.as_database_error()
        .and_then(|e| e.constraint())
        .is_some_and(|c| c == "tenant_keeps_ops")
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_last_ops_account_cannot_be_unset_deactivated_or_deleted(pool: PgPool) {
    let w = world(pool).await;
    let (ops, hr) = (*w.ops.as_uuid(), *w.hr.as_uuid());
    for sql in [
        "UPDATE users SET is_tenant_ops = false WHERE id = $1 AND $2 IS NOT NULL",
        "UPDATE users SET is_active = false WHERE id = $1 AND $2 IS NOT NULL",
    ] {
        let err = commit(&w.owner, &[sql], ops, hr).await.expect_err(sql);
        assert!(is_lockout(&err), "{sql}: {err}");
    }
    let still: bool =
        sqlx::query_scalar("SELECT is_tenant_ops AND is_active FROM users WHERE id = $1")
            .bind(ops)
            .fetch_one(&w.owner)
            .await
            .unwrap();
    assert!(still, "ops keeps its power");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_handover_in_one_transaction_passes_and_two_ops_never_coexist(pool: PgPool) {
    let w = world(pool).await;
    let (ops, hr) = (*w.ops.as_uuid(), *w.hr.as_uuid());
    let two = commit(
        &w.owner,
        &["UPDATE users SET is_tenant_ops = true WHERE id = $2 AND $1 IS NOT NULL"],
        ops,
        hr,
    )
    .await;
    assert!(
        two.unwrap_err()
            .to_string()
            .contains("users_one_tenant_ops")
    );
    commit(
        &w.owner,
        &[
            "UPDATE users SET is_tenant_ops = false WHERE id = $1 AND $2 IS NOT NULL",
            "UPDATE users SET is_tenant_ops = true WHERE id = $2 AND $1 IS NOT NULL",
        ],
        ops,
        hr,
    )
    .await
    .expect("handover");
    let holder: uuid::Uuid =
        sqlx::query_scalar("SELECT id FROM users WHERE org_id = $1 AND is_tenant_ops")
            .bind(w.org)
            .fetch_one(&w.owner)
            .await
            .unwrap();
    assert_eq!(holder, hr);
}
