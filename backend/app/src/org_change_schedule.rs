// SPDX-License-Identifier: LicenseRef-Proprietary
//! Scheduled org changes use the tenant's orgchange.apply_time in the platform zone.
//! The lifecycle tick owns the loop; the store owns locking, audit and idempotency.

use crate::wiring::orgchange_ports::{PgEmploymentTransferPort, PgOrgUnitWritePort};
use console_orgchange_adapter_postgres::PgOrgChangeStore;
use sqlx::PgPool;
use time::{Date, OffsetDateTime};

/// Apply due changes using the current UTC clock and each tenant's configured time.
pub async fn apply_due_org_changes(pool: &PgPool, today: Date) -> Result<usize, String> {
    apply_due_org_changes_at(pool, today, OffsetDateTime::now_utc()).await
}

/// The same worker call with an explicit UTC clock for deterministic boundary checks.
pub async fn apply_due_org_changes_at(
    pool: &PgPool,
    today: Date,
    now: OffsetDateTime,
) -> Result<usize, String> {
    PgOrgChangeStore::new(pool.clone())
        .with_employment_transfer(std::sync::Arc::new(PgEmploymentTransferPort))
        .with_org_unit_write(std::sync::Arc::new(PgOrgUnitWritePort))
        .effectuate_due_at(today, now)
        .await
}

pub(crate) async fn tick(pool: &PgPool, today: Date) {
    match apply_due_org_changes(pool, today).await {
        Ok(0) => {}
        Ok(applied) => tracing::info!(applied, "scheduled org changes applied"),
        Err(error) => tracing::warn!(%error, "scheduled org change run failed"),
    }
}
