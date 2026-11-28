#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! A tenant with an ops account keeps at least one and at most two active holders.
//! The minimum is deferred so the sole holder can hand over in one transaction.

mod support;

use sqlx::PgPool;
use support::world;

async fn commit(pool: &PgPool, statements: &[(&str, uuid::Uuid)]) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    for &(sql, user) in statements {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_owned()))
            .bind(user)
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
    let ops = *w.ops.as_uuid();
    for sql in [
        "UPDATE users SET is_tenant_ops = false WHERE id = $1",
        "UPDATE users SET is_active = false WHERE id = $1",
    ] {
        let err = commit(&w.owner, &[(sql, ops)]).await.expect_err(sql);
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
async fn two_active_holders_can_coexist_and_a_sole_holder_can_hand_over(pool: PgPool) {
    const GRANT: &str = "UPDATE users SET is_tenant_ops = true WHERE id = $1";
    const REVOKE: &str = "UPDATE users SET is_tenant_ops = false WHERE id = $1";
    let w = world(pool).await;
    let (ops, hr, hr2) = (*w.ops.as_uuid(), *w.hr.as_uuid(), *w.hr2.as_uuid());
    commit(&w.owner, &[(GRANT, hr)])
        .await
        .expect("second holder");
    let err = commit(&w.owner, &[(GRANT, hr2)])
        .await
        .expect_err("third active holder exceeds the cap");
    assert_eq!(
        err.as_database_error().and_then(|e| e.constraint()),
        Some("ops_holder_limit_reached")
    );
    commit(&w.owner, &[(REVOKE, hr)])
        .await
        .expect("restore sole holder");
    commit(&w.owner, &[(REVOKE, ops), (GRANT, hr)])
        .await
        .expect("atomic handover");
    let holders: Vec<uuid::Uuid> = sqlx::query_scalar(
        "SELECT id FROM users WHERE org_id = $1 AND is_active AND is_tenant_ops",
    )
    .bind(w.org)
    .fetch_all(&w.owner)
    .await
    .unwrap();
    assert_eq!(holders, vec![hr]);
}
