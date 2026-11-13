// SPDX-License-Identifier: LicenseRef-Proprietary
//! One register snapshot (including a failed read) for this inbox request.
use console_compliance_adapter_postgres::statutory::StatutoryRegister;
use console_kernel_core::{KernelError, OrgId};
use sqlx::{Acquire, PgConnection, PgPool};
use std::sync::Arc;
use time::{Date, OffsetDateTime};
use tokio::sync::OnceCell;

pub(super) type Register = Arc<OnceCell<Result<StatutoryRegister, KernelError>>>;

pub(super) async fn get(
    pool: &PgPool,
    register: &Register,
    org: OrgId,
    as_of: OffsetDateTime,
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
                db(error)
            })?;
            let mut tx = conn.begin().await.map_err(db)?;
            sqlx::query("SELECT set_config('app.current_org',$1,true)")
                .bind(org.to_string()).execute(tx.as_mut()).await.map_err(db)?;
            let value = read(tx.as_mut(), org, as_of).await?;
            tx.commit().await.map_err(db)?;
            Ok(value)
        })
        .await
        .clone()
}

pub(super) async fn get_in(
    conn: &mut PgConnection,
    register: &Register,
    org: OrgId,
    as_of: OffsetDateTime,
) -> Result<StatutoryRegister, KernelError> {
    register
        .get_or_init(|| read(conn, org, as_of))
        .await
        .clone()
}

async fn read(
    conn: &mut PgConnection,
    org: OrgId,
    as_of: OffsetDateTime,
) -> Result<StatutoryRegister, KernelError> {
    let result = async {
        // A broken source must not take the other source's shared register down.
        let mut bounds = conn.begin().await.map_err(db)?;
        let dates = sqlx::query_scalar::<_, Vec<Option<Date>>>(
            "SELECT ARRAY[min(on_date),max(on_date)] FROM ( \
            SELECT effective_date::date AS on_date FROM employee_lifecycle_events WHERE org_id=$1 \
            UNION ALL SELECT anchor_on FROM insurance_filing_requests WHERE org_id=$1 \
            UNION ALL SELECT effective_exit_date FROM employee_exit_cases WHERE org_id=$1 \
            UNION ALL SELECT ($2::timestamptz AT TIME ZONE z.time_zone)::date FROM ( \
                SELECT time_zone FROM lifecycle_country_packs WHERE is_default \
                UNION SELECT time_zone FROM workplaces WHERE org_id=$1 \
                UNION SELECT time_zone FROM legal_entities WHERE org_id=$1) z) dates",
        )
        .bind(org.as_uuid())
        .bind(as_of)
        .fetch_one(bounds.as_mut())
        .await;
        let dates = match dates {
            Ok(dates) => {
                bounds.commit().await.map_err(db)?;
                dates.into_iter().flatten().collect::<Vec<_>>()
            }
            Err(_) => {
                bounds.rollback().await.map_err(db)?;
                Vec::new()
            }
        };
        console_platform_db::statutory_read::load_statutory_register_for_dates(conn, &dates).await
    }
    .await;
    result.map_err(|error: KernelError| {
        tracing::error!(source = "statutory_register", failure_kind = "register_fault", error = %error, "action-inbox register unavailable");
        error
    })
}

fn db(error: sqlx::Error) -> KernelError {
    let error = console_platform_db::DbError::from(error);
    KernelError::new(error.kind(), error.to_string())
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
        let org = OrgId::new();
        let as_of = OffsetDateTime::now_utc();
        let logs = reference_logs::Logs::default();
        let writer = logs.clone();
        let subscriber = tracing_subscriber::fmt()
            .json()
            .with_writer(move || writer.clone())
            .finish();
        let error = get(&starved, &cache, org, as_of)
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
        assert_eq!(get(&starved, &cache, org, as_of).await.unwrap_err(), error);
        assert!(
            get(&starved, &Register::default(), org, as_of)
                .await
                .is_ok()
        );
    }
}
