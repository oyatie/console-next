// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn overlapping_reservations_recheck_the_committed_hash_after_waiting(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let org = *f.principal.org_id.as_uuid();
    let mut first = transaction(&f).await;
    let first_queries = observe();
    reserve_create_keys(&mut first, org, &[("b", HASH_A), ("a", HASH_A)])
        .with_subscriber(first_queries.clone())
        .await
        .unwrap();
    assert_eq!(first_queries.statements().len(), 2);
    let mut second = transaction(&f).await;
    let second_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(second.as_mut())
        .await
        .unwrap();
    let queries = observe();
    let waiting = async {
        let result = reserve_create_keys(&mut second, org, &[("a", HASH_B), ("b", HASH_A)])
            .with_subscriber(queries.clone())
            .await;
        second.rollback().await.unwrap();
        result
    };
    let commit = async {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let blocked: bool =
                    sqlx::query_scalar("SELECT cardinality(pg_blocking_pids($1)) > 0")
                        .bind(second_pid)
                        .fetch_one(&pool)
                        .await
                        .unwrap();
                if blocked {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the overlapping reservation must actually wait on the first transaction");
        first.commit().await.unwrap();
    };
    let (result, ()) = tokio::join!(waiting, commit);
    assert_eq!(result.unwrap_err().code, "idempotency_key_reused");
    assert_eq!(queries.statements().len(), 2);
}
