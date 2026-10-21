//! Moves a test tenant past 운영 시작 (E-S3b: transfers, leave and exits wait
//! for it; the organizations trigger opens every tenant in SETUP).

use sqlx::PgPool;
use uuid::Uuid;

pub async fn go_live(pool: &PgPool, org: Uuid) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    // rls-arming: ok test fixture moves the tenant past 운영 시작 as owner
    sqlx::query("UPDATE tenant_phase SET phase = 'OPERATING'")
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
}
