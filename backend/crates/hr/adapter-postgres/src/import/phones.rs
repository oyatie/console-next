//! W12: the 휴대전화 of import rows. Phone headers are restricted (never in a
//! raw row), so the E.164 number is staged apart (`data_import_row_phones`)
//! at the preview, moved to the employment profile by the settle and deleted
//! with it; a run never applied loses them with its staged identities.

use std::collections::{BTreeMap, BTreeSet};

use sqlx::Postgres;
use uuid::Uuid;

use crate::HrError;

/// Stages `(source_key, E.164)` of a run.
pub async fn stage(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    run: Uuid,
    phones: &[(String, String)],
) -> Result<(), HrError> {
    let (keys, numbers): (Vec<&String>, Vec<&String>) = phones.iter().map(|(k, p)| (k, p)).unzip();
    sqlx::query(
        "INSERT INTO data_import_row_phones (org_id, run_id, source_key, phone_e164) \
         SELECT $1, $2, k, p FROM unnest($3::TEXT[], $4::TEXT[]) AS t(k, p)",
    )
    .bind(org)
    .bind(run)
    .bind(&keys)
    .bind(&numbers)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

/// The rows of a run that carry a 휴대전화 (never the numbers).
pub async fn run_keys(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    run: Uuid,
) -> Result<BTreeSet<String>, HrError> {
    let keys: Vec<String> = sqlx::query_scalar(
        "SELECT source_key FROM data_import_row_phones WHERE org_id = $1 AND run_id = $2",
    )
    .bind(org)
    .bind(run)
    .fetch_all(tx.as_mut())
    .await?;
    Ok(keys.into_iter().collect())
}

/// Takes the staged numbers of `keys` (deleted here: the settle stores them
/// on the profile in the same transaction).
pub async fn take(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    run: Uuid,
    keys: &[String],
) -> Result<BTreeMap<String, String>, HrError> {
    let taken: Vec<(String, String)> = sqlx::query_as(
        "DELETE FROM data_import_row_phones WHERE org_id = $1 AND run_id = $2 \
           AND source_key = ANY($3) RETURNING source_key, phone_e164",
    )
    .bind(org)
    .bind(run)
    .bind(keys)
    .fetch_all(tx.as_mut())
    .await?;
    Ok(taken.into_iter().collect())
}

/// Drops what is left of a run's numbers (rows it did not insert), or every
/// tenant run's older than `days` (`run: None`).
pub async fn drop_staged(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    run: Option<Uuid>,
    days: i32,
) -> Result<(), HrError> {
    sqlx::query(
        "DELETE FROM data_import_row_phones WHERE org_id = $1 \
           AND (run_id = $2 OR ($2 IS NULL AND created_at < now() - make_interval(days => $3)))",
    )
    .bind(org)
    .bind(run)
    .bind(days)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}
