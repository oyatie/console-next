// SPDX-License-Identifier: LicenseRef-Proprietary
//! Observe actual runtime-pool leases while exercising the product router.
use super::http;
use console_app::build_router;
use console_kernel_core::UserId;
use console_settings_domain::{SettingKey, SettingValue};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;
use uuid::Uuid;

pub struct Probe {
    pub pool: PgPool,
    acquisitions: Arc<AtomicUsize>,
}
impl Probe {
    pub fn reset(&self) {
        self.acquisitions.store(0, Ordering::SeqCst);
    }
    pub fn acquisitions(&self) -> usize {
        self.acquisitions.load(Ordering::SeqCst)
    }
    pub fn cap(&self) -> usize {
        let Some(SettingValue::Int(cap)) = "action_inbox.source_concurrency"
            .parse::<SettingKey>()
            .ok()
            .and_then(|key| key.def().default)
            .or(Some(SettingValue::Int(4)))
        else {
            panic!("source read setting must be an integer");
        };
        usize::try_from(cap)
            .unwrap()
            .min((self.pool.options().get_max_connections() as usize - 1) / 2)
            .max(1)
    }
    pub async fn measure<T>(&self, read: impl std::future::Future<Output = T>) -> (T, usize) {
        let mut peak = 0;
        let mut interval = tokio::time::interval(Duration::from_millis(1));
        tokio::pin!(read);
        loop {
            tokio::select! {
                result = &mut read => return (result, peak),
                _ = interval.tick() => { peak = peak.max(self.pool.size() as usize - self.pool.num_idle()); }
            }
        }
    }
}
pub async fn context(owner: &PgPool, org: Uuid, user: UserId) -> (http::Ctx, Probe) {
    // Use the same pool size as support/http, pre-opened so every lease hits before_acquire.
    let acquisitions = Arc::new(AtomicUsize::new(0));
    let record = acquisitions.clone();
    let pool = PgPoolOptions::new()
        .min_connections(8)
        .max_connections(8)
        .acquire_timeout(Duration::from_secs(1))
        .after_connect(|conn, _| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_rt").execute(conn).await?;
                Ok(())
            })
        })
        .before_acquire(move |_, _| {
            record.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(true) })
        })
        .connect_with(owner.connect_options().as_ref().clone())
        .await
        .unwrap();
    let keys = http::keys();
    let mut ctx = http::ctx(owner, org, user, &["SUPER_ADMIN"], None).await;
    ctx.service = build_router(http::app_state(
        pool.clone(),
        http::role_pool(owner, "console_leave_cmd", None).await,
        &keys,
    ));
    ctx.token = http::token(owner, &keys, org, user, &["SUPER_ADMIN"]).await;
    (ctx, Probe { pool, acquisitions })
}
