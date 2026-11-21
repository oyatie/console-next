// SPDX-License-Identifier: LicenseRef-Proprietary
//! Post-commit S3 object purge outbox drainer and erasure witness logger for
//! completed two-operator tenant erasures.

use console_kernel_core::OrgId;
use console_platform_db::with_org_conn;
use console_platform_storage::{S3ObjectStore, StorageError};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{PlatformProvisioner, ProvisioningError};

const S3_DRAIN_BATCH_LIMIT: i64 = 100;
const WORM_RETENTION_REASON: &str = "worm_retention_active";

/// Summary counts from one pass over `tenant_erase_s3_outbox`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct S3OutboxDrainStats {
    pub deleted: usize,
    pub deferred_worm: usize,
    pub retried: usize,
}

#[derive(Debug, sqlx::FromRow)]
struct OutboxRow {
    id: Uuid,
    bucket_kind: String,
    explicit_bucket: Option<String>,
    object_key: String,
    attempts: i32,
}

#[derive(Debug, sqlx::FromRow)]
struct WitnessRow {
    id: Uuid,
    target_org_id: Uuid,
    erasure_witness_seq: i64,
    erasure_witness_hash: Vec<u8>,
    shredded_key_fingerprint: Vec<u8>,
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn is_not_found_error(err: &StorageError) -> bool {
    let StorageError::S3(msg) = err else {
        return false;
    };
    msg.contains("404") || msg.contains("NoSuchKey") || msg.contains("Not Found")
}

fn is_worm_retention_error(err: &StorageError) -> bool {
    let StorageError::S3(msg) = err else {
        return false;
    };
    msg.contains("403")
        || msg.contains("AccessDenied")
        || msg.contains("ObjectLock")
        || msg.contains("Retention")
}

fn truncate_error(err: &StorageError) -> String {
    let raw = err.to_string();
    let mut out = String::new();
    for ch in raw.chars().take(240) {
        out.push(ch);
    }
    out
}

impl PlatformProvisioner {
    /// Emit structured, zero-PII witness logs for any newly completed tenant
    /// erasures whose `erasure_witness_seq > after_seq`. Returns
    /// `(emitted_count, highest_seq_seen)`.
    pub async fn emit_erase_witnesses_after(
        pool: &PgPool,
        after_seq: i64,
    ) -> Result<(usize, i64), ProvisioningError> {
        let rows: Vec<WitnessRow> =
            with_org_conn::<_, _, ProvisioningError>(pool, OrgId::platform(), move |tx| {
                Box::pin(async move {
                    Ok(sqlx::query_as(
                        "SELECT id, target_org_id, erasure_witness_seq, \
                                erasure_witness_hash, shredded_key_fingerprint \
                           FROM tenant_erase_requests \
                          WHERE org_id = $1 \
                            AND erased_at IS NOT NULL \
                            AND erasure_witness_seq IS NOT NULL \
                            AND erasure_witness_hash IS NOT NULL \
                            AND shredded_key_fingerprint IS NOT NULL \
                            AND erasure_witness_seq > $2 \
                          ORDER BY erasure_witness_seq ASC \
                          LIMIT 100",
                    )
                    .bind(OrgId::platform().as_uuid())
                    .bind(after_seq)
                    .fetch_all(tx.as_mut())
                    .await?)
                })
            })
            .await?;

        let mut max_seq = after_seq;
        for row in &rows {
            let entry_hash = hex_lower(&row.erasure_witness_hash);
            let key_fingerprint = hex_lower(&row.shredded_key_fingerprint);
            tracing::info!(
                target: "console.erasure_ledger.witness",
                request_id = %row.id,
                org_id = %row.target_org_id,
                seq = row.erasure_witness_seq,
                entry_hash = %entry_hash,
                key_fingerprint = %key_fingerprint,
                "tenant DEK shredded and erasure ledger witnessed"
            );
            if row.erasure_witness_seq > max_seq {
                max_seq = row.erasure_witness_seq;
            }
        }
        Ok((rows.len(), max_seq))
    }

    /// Drain due S3 delete entries from `tenant_erase_s3_outbox` without
    /// holding any database transaction across HTTP calls to object storage.
    pub async fn drain_erased_tenant_objects(
        pool: &PgPool,
        store: &dyn S3ObjectStore,
        primary_bucket: &str,
        replica_bucket: Option<&str>,
    ) -> Result<S3OutboxDrainStats, ProvisioningError> {
        let due: Vec<OutboxRow> =
            with_org_conn::<_, _, ProvisioningError>(pool, OrgId::platform(), move |tx| {
                Box::pin(async move {
                    Ok(sqlx::query_as(
                        "SELECT id, bucket_kind, explicit_bucket, object_key, attempts \
                           FROM tenant_erase_s3_outbox \
                          WHERE org_id = $1 \
                            AND next_retry_at <= clock_timestamp() \
                          ORDER BY created_at ASC, id ASC \
                          LIMIT $2",
                    )
                    .bind(OrgId::platform().as_uuid())
                    .bind(S3_DRAIN_BATCH_LIMIT)
                    .fetch_all(tx.as_mut())
                    .await?)
                })
            })
            .await?;

        let mut stats = S3OutboxDrainStats::default();
        for row in due {
            let target_bucket = match row.bucket_kind.as_str() {
                "PRIMARY" => Some(primary_bucket),
                "REPLICA" => replica_bucket,
                "EXPLICIT" => row.explicit_bucket.as_deref(),
                _ => None,
            };
            let Some(bucket) = target_bucket.filter(|b| !b.trim().is_empty()) else {
                mark_retry(pool, row.id, 3600.0, "bucket_unconfigured").await?;
                stats.retried += 1;
                continue;
            };

            match store.delete_object(bucket.to_owned(), row.object_key).await {
                Ok(()) => {
                    delete_outbox_row(pool, row.id).await?;
                    stats.deleted += 1;
                }
                Err(ref err) if is_not_found_error(err) => {
                    delete_outbox_row(pool, row.id).await?;
                    stats.deleted += 1;
                }
                Err(ref err) if row.bucket_kind == "REPLICA" && is_worm_retention_error(err) => {
                    mark_worm_deferred(pool, row.id).await?;
                    stats.deferred_worm += 1;
                }
                Err(err) => {
                    let shift = row.attempts.clamp(0, 6);
                    let backoff_secs = (60_i64.saturating_mul(1_i64 << shift)).min(3600) as f64;
                    let summary = truncate_error(&err);
                    mark_retry(pool, row.id, backoff_secs, &summary).await?;
                    stats.retried += 1;
                }
            }
        }
        Ok(stats)
    }
}

async fn delete_outbox_row(pool: &PgPool, id: Uuid) -> Result<(), ProvisioningError> {
    with_org_conn::<_, _, ProvisioningError>(pool, OrgId::platform(), move |tx| {
        Box::pin(async move {
            sqlx::query("DELETE FROM tenant_erase_s3_outbox WHERE org_id = $1 AND id = $2")
                .bind(OrgId::platform().as_uuid())
                .bind(id)
                .execute(tx.as_mut())
                .await?;
            Ok(())
        })
    })
    .await?;
    Ok(())
}

async fn mark_worm_deferred(pool: &PgPool, id: Uuid) -> Result<(), ProvisioningError> {
    with_org_conn::<_, _, ProvisioningError>(pool, OrgId::platform(), move |tx| {
        Box::pin(async move {
            sqlx::query(
                "UPDATE tenant_erase_s3_outbox \
                    SET attempts = attempts + 1, \
                        next_retry_at = clock_timestamp() + interval '24 hours', \
                        last_error = $3 \
                  WHERE org_id = $1 AND id = $2",
            )
            .bind(OrgId::platform().as_uuid())
            .bind(id)
            .bind(WORM_RETENTION_REASON)
            .execute(tx.as_mut())
            .await?;
            Ok(())
        })
    })
    .await?;
    Ok(())
}

async fn mark_retry(
    pool: &PgPool,
    id: Uuid,
    backoff_secs: f64,
    last_error: &str,
) -> Result<(), ProvisioningError> {
    let reason = last_error.to_owned();
    with_org_conn::<_, _, ProvisioningError>(pool, OrgId::platform(), move |tx| {
        Box::pin(async move {
            sqlx::query(
                "UPDATE tenant_erase_s3_outbox \
                    SET attempts = attempts + 1, \
                        next_retry_at = clock_timestamp() + make_interval(secs => $3), \
                        last_error = $4 \
                  WHERE org_id = $1 AND id = $2",
            )
            .bind(OrgId::platform().as_uuid())
            .bind(id)
            .bind(backoff_secs)
            .bind(reason)
            .execute(tx.as_mut())
            .await?;
            Ok(())
        })
    })
    .await?;
    Ok(())
}
