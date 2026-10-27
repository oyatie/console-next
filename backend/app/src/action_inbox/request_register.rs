// SPDX-License-Identifier: LicenseRef-Proprietary
//! One register snapshot (including a failed read) for this inbox request.
use console_compliance_adapter_postgres::statutory::{StatutoryRegister, load_statutory_register};
use console_kernel_core::KernelError;
use sqlx::{PgConnection, PgPool};
use std::sync::Arc;
use tokio::sync::OnceCell;

pub(super) type Register = Arc<OnceCell<Result<StatutoryRegister, KernelError>>>;

pub(super) async fn get(
    pool: &PgPool,
    register: &Register,
) -> Result<StatutoryRegister, KernelError> {
    register
        .get_or_init(|| async {
            let mut conn = pool.acquire().await.map_err(|error| {
                let failure_kind = if matches!(error, sqlx::Error::PoolTimedOut) {
                    "pool_timeout"
                } else {
                    "pool_unavailable"
                };
                tracing::error!(source = "statutory_register", failure_kind, error = %error, "action-inbox register unavailable");
                let error = console_platform_db::DbError::from(error);
                KernelError::new(error.kind(), error.to_string())
            })?;
            read(&mut conn).await
        })
        .await
        .clone()
}

pub(super) async fn get_in(
    conn: &mut PgConnection,
    register: &Register,
) -> Result<StatutoryRegister, KernelError> {
    register.get_or_init(|| read(conn)).await.clone()
}

async fn read(conn: &mut PgConnection) -> Result<StatutoryRegister, KernelError> {
    load_statutory_register(conn).await.map_err(|error| {
        tracing::error!(source = "statutory_register", failure_kind = "register_fault", error = %error, "action-inbox register unavailable");
        KernelError::new(error.kind(), error.to_string())
    })
}

#[cfg(test)]
#[allow(dead_code)]
#[path = "../../tests/support/reference_logs.rs"]
mod reference_logs;

#[cfg(test)]
mod tests {
    use super::*;
    use tracing::instrument::WithSubscriber;

    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn register_pool_timeout_logs_its_typed_cause_and_is_cached(pool: PgPool) {
        let starved = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(std::time::Duration::from_secs(1))
            .connect_with(pool.connect_options().as_ref().clone())
            .await
            .unwrap();
        let held = starved.acquire().await.unwrap();
        let cache = Register::default();
        let logs = reference_logs::Logs::default();
        let writer = logs.clone();
        let subscriber = tracing_subscriber::fmt()
            .json()
            .with_writer(move || writer.clone())
            .finish();
        let error = get(&starved, &cache)
            .with_subscriber(subscriber)
            .await
            .unwrap_err();
        assert_eq!(error.kind, console_kernel_core::ErrorKind::Unavailable);
        let raw = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
        let event: serde_json::Value = serde_json::from_str(raw.trim()).unwrap();
        assert_eq!(event["fields"]["failure_kind"], "pool_timeout");
        assert_eq!(
            event["fields"]["error"],
            sqlx::Error::PoolTimedOut.to_string()
        );
        drop(held);
        assert_eq!(get(&starved, &cache).await.unwrap_err(), error);
        assert!(get(&starved, &Register::default()).await.is_ok());
    }
}
