// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_platform_test_support::{MIGRATOR, seed_org_and_super_admin};
use sqlx::{PgPool, postgres::PgPoolOptions};
use uuid::Uuid;

#[sqlx::test(migrator = "MIGRATOR")]
async fn support_ledger_is_tenant_partitioned_and_approval_cannot_be_fabricated(pool: PgPool) {
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    seed_org_and_super_admin(&pool, a, "support-a").await;
    seed_org_and_super_admin(&pool, b, "support-b").await;
    let rt = PgPoolOptions::new()
        .max_connections(2)
        .after_connect(|c, _| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_rt").execute(c).await?;
                Ok(())
            })
        })
        .connect_with(pool.connect_options().as_ref().clone())
        .await
        .unwrap();
    let mut tx = rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(a.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO support_sessions (org_id,id,operator_ref,operator_label,ticket_ref,reason_code,reason,scope,requested_duration_seconds,request_expires_at,request_assertion) VALUES ($1,$2,$3,'공급사 · 담당자','T-123','TROUBLESHOOT','조회 오류 조사',ARRAY['org'],60,now()+interval '1 hour',$4)")
        .bind(a).bind(id).bind(Uuid::new_v4()).bind(Uuid::new_v4()).execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    let mut tx = rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(b.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM support_sessions")
            .fetch_one(tx.as_mut())
            .await
            .unwrap(),
        0
    );
    tx.rollback().await.unwrap();
    let mut tx = rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(a.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    assert!(
        sqlx::query("UPDATE support_sessions SET state='ACTIVE' WHERE id=$1")
            .bind(id)
            .execute(tx.as_mut())
            .await
            .is_err(),
        "a request cannot skip both approvals"
    );
    tx.rollback().await.unwrap();
}
