// SPDX-License-Identifier: LicenseRef-Proprietary
//! Snapshot reads whose canonical fact resolvers acquire row locks.
use crate::{DbError, audit_tx::set_current_org};
use console_kernel_core::OrgId;
use sqlx::{PgPool, Postgres, Transaction};

/// Keep facts and projection consistent while permitting `SELECT FOR SHARE`.
/// Unlike a read-only snapshot, this supports the canonical identity resolver.
pub async fn with_org_locking_snapshot<F, T, E>(pool: &PgPool, org: OrgId, f: F) -> Result<T, E>
where
    F: for<'tx> FnOnce(
        &'tx mut Transaction<'_, Postgres>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<T, E>> + Send + 'tx>,
    >,
    E: From<DbError>,
{
    let mut tx = pool.begin().await.map_err(|e| E::from(DbError::begin(e)))?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(tx.as_mut())
        .await
        .map_err(|e| E::from(DbError::Sqlx(e)))?;
    set_current_org(&mut tx, org).await.map_err(E::from)?;
    let value = f(&mut tx).await?;
    tx.commit().await.map_err(|e| E::from(DbError::Sqlx(e)))?;
    Ok(value)
}
