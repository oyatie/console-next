// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::panic)]
use console_kernel_core::OrgId;
use console_platform_db::{DbError, with_org_conn, with_org_snapshot};
use sqlx::{PgPool, Postgres, Transaction, postgres::PgPoolOptions};
use std::sync::Arc;
use tokio::sync::Semaphore;

async fn read(tx: &mut Transaction<'_, Postgres>, refuse: bool) -> Result<String, DbError> {
    let org = sqlx::query_scalar("SELECT current_setting('app.current_org')")
        .fetch_one(tx.as_mut())
        .await?;
    if refuse {
        sqlx::query("SELECT 1 / 0").execute(tx.as_mut()).await?;
    }
    Ok(org)
}

#[sqlx::test(migrations = false)]
async fn tenant_reads_return_their_lease_before_completing_on_commit_or_rollback(pool: PgPool) {
    for snapshot in [false, true] {
        for refuse in [false, true] {
            let returning = Arc::new(Semaphore::new(0));
            let release = Arc::new(Semaphore::new(0));
            let (entered, gate) = (returning.clone(), release.clone());
            let reader = PgPoolOptions::new()
                .max_connections(1)
                .after_release(move |_, _| {
                    let (entered, gate) = (entered.clone(), gate.clone());
                    Box::pin(async move {
                        entered.add_permits(1);
                        gate.acquire().await.unwrap().forget();
                        Ok(true)
                    })
                })
                .connect_lazy_with(pool.connect_options().as_ref().clone());
            let org = OrgId::new();
            let operation = async {
                if snapshot {
                    with_org_snapshot(&reader, org, |tx| Box::pin(read(tx, refuse))).await
                } else {
                    with_org_conn(&reader, org, |tx| Box::pin(read(tx, refuse))).await
                }
            };
            tokio::pin!(operation);
            tokio::select! {
                biased;
                result = &mut operation => panic!("tenant read completed before its lease returned: {result:?}"),
                entered = returning.acquire() => entered.unwrap().forget(),
            }
            release.add_permits(1);
            let result = operation.await;
            if refuse {
                assert!(result.is_err());
            } else {
                assert_eq!(result.unwrap(), org.to_string());
            }
            assert_eq!(reader.num_idle(), 1);
            let mut conn = reader.acquire().await.unwrap();
            let bound: Option<String> =
                sqlx::query_scalar("SELECT NULLIF(current_setting('app.current_org',true),'')")
                    .fetch_one(&mut *conn)
                    .await
                    .unwrap();
            assert_eq!(bound, None);
            release.add_permits(1);
            conn.return_to_pool().await;
            reader.close().await;
        }
    }
}
