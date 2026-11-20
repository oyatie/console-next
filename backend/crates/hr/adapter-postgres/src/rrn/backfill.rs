// SPDX-License-Identifier: LicenseRef-Proprietary
//! Idempotent, RLS-armed, audited batched backfill of `employee_rrn`
//! tenant-bound v2+ blind indexes (`rrn_hmac_v2`, `blind_index_version`).
//! Leaves legacy `rrn_hmac` untouched for N-1 rollback safety.

use std::sync::Arc;

use console_hr_domain::import::rrn_value::RrnVault;
use console_kernel_core::{AuditAction, AuditEvent, AuditSource, OrgId, TraceContext};
use console_platform_db::{with_audits, with_org_conn};
use serde_json::json;
use sqlx::Row;
use time::OffsetDateTime;
use uuid::Uuid;

use super::unavailable;
use crate::import::identities::sealed_from_row;
use crate::{HrError, HrService};

const DEFAULT_BATCH_SIZE: i64 = 100;
const MAX_BATCHES_PER_ORG_PER_TICK: usize = 10;

impl HrService {
    /// Discover tenants and backfill pending `employee_rrn` rows up to the
    /// active tenant-bound blind-index version. Returns total updated rows.
    ///
    /// # Errors
    /// Only when listing organizations itself fails; per-tenant failures are
    /// logged (without RRN or HMAC material) and retried on the next tick.
    pub async fn backfill_rrn_blind_indexes(
        &self,
        vault: Arc<dyn RrnVault>,
    ) -> Result<usize, HrError> {
        let orgs: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM platform_list_organizations()")
            // rls-arming: ok platform_list_organizations() is the SECURITY DEFINER id-only tenant discovery; every per-org statement below runs under with_org_conn / with_audits
            .fetch_all(&self.pool)
            .await?;
        let mut total_updated = 0;
        for org_uuid in orgs {
            match self
                .backfill_rrn_blind_indexes_in_org(
                    OrgId::from_uuid(org_uuid),
                    vault.clone(),
                    DEFAULT_BATCH_SIZE,
                    MAX_BATCHES_PER_ORG_PER_TICK,
                )
                .await
            {
                Ok(n) => total_updated += n,
                Err(error) => tracing::warn!(
                    org = %org_uuid,
                    error = %error.message,
                    "employee RRN blind-index backfill failed; retrying next run"
                ),
            }
        }
        Ok(total_updated)
    }

    /// Backfill up to `max_batches` of size `batch_size` for a single tenant.
    pub async fn backfill_rrn_blind_indexes_in_org(
        &self,
        org: OrgId,
        vault: Arc<dyn RrnVault>,
        batch_size: i64,
        max_batches: usize,
    ) -> Result<usize, HrError> {
        let target_version = vault.active_blind_index_version();
        if target_version < 2 || batch_size <= 0 || max_batches == 0 {
            return Ok(0);
        }
        let mut updated = 0;
        for _ in 0..max_batches {
            let batch_updated = self
                .backfill_rrn_blind_index_batch(org, vault.clone(), target_version, batch_size)
                .await?;
            updated += batch_updated;
            if batch_updated == 0 {
                break;
            }
        }
        Ok(updated)
    }

    /// Execute at most one bounded `FOR UPDATE SKIP LOCKED` backfill batch for `org`.
    pub async fn backfill_rrn_blind_index_batch(
        &self,
        org: OrgId,
        vault: Arc<dyn RrnVault>,
        target_version: i16,
        batch_size: i64,
    ) -> Result<usize, HrError> {
        if target_version < 2 || batch_size <= 0 {
            return Ok(0);
        }
        let org_uuid = *org.as_uuid();
        let needs_backfill: bool = with_org_conn::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                Ok(sqlx::query_scalar(
                    "SELECT EXISTS ( \
                       SELECT 1 FROM employee_rrn \
                        WHERE org_id = $1 \
                          AND (rrn_hmac_v2 IS NULL \
                               OR blind_index_version IS NULL \
                               OR blind_index_version < $2) \
                     )",
                )
                .bind(org_uuid)
                .bind(target_version)
                .fetch_one(tx.as_mut())
                .await?)
            })
        })
        .await?;
        if !needs_backfill {
            return Ok(0);
        }

        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let rows = sqlx::query(
                    "SELECT employee_id, rrn_hmac, hmac_key_version, rrn_hmac_v2, \
                            blind_index_version, ciphertext, nonce, dek_wrapped, dek_nonce, \
                            key_version, masked, alg_id, kek_id, msg_id, commitment_tag \
                       FROM employee_rrn \
                      WHERE org_id = $1 \
                        AND (rrn_hmac_v2 IS NULL \
                             OR blind_index_version IS NULL \
                             OR blind_index_version < $2) \
                      ORDER BY employee_id \
                      LIMIT $3 \
                      FOR UPDATE SKIP LOCKED",
                )
                .bind(org_uuid)
                .bind(target_version)
                .bind(batch_size)
                .fetch_all(tx.as_mut())
                .await?;
                if rows.is_empty() {
                    return Ok((0, Vec::new()));
                }

                let mut employee_ids = Vec::with_capacity(rows.len());
                let mut v2_hmacs = Vec::with_capacity(rows.len());
                let mut v2_versions = Vec::with_capacity(rows.len());
                for row in &rows {
                    let employee_id: Uuid = row.try_get("employee_id")?;
                    let sealed = sealed_from_row(row)?;
                    let (hmac_v2, ver) = vault
                        .rekey_blind_index_v2(org_uuid, &sealed)
                        .map_err(|_| unavailable())?;
                    employee_ids.push(employee_id);
                    v2_hmacs.push(hmac_v2);
                    v2_versions.push(ver);
                }

                let result = sqlx::query(
                    "UPDATE employee_rrn AS r \
                        SET rrn_hmac_v2 = v.hmac_v2, \
                            blind_index_version = v.version \
                       FROM unnest($2::uuid[], $3::bytea[], $4::smallint[]) \
                         AS v(employee_id, hmac_v2, version) \
                      WHERE r.org_id = $1 \
                        AND r.employee_id = v.employee_id \
                        AND (r.rrn_hmac_v2 IS NULL \
                             OR r.blind_index_version IS NULL \
                             OR r.blind_index_version < v.version)",
                )
                .bind(org_uuid)
                .bind(&employee_ids)
                .bind(&v2_hmacs)
                .bind(&v2_versions)
                .execute(tx.as_mut())
                .await?;
                let updated = usize::try_from(result.rows_affected()).unwrap_or(0);
                if updated == 0 {
                    return Ok((0, Vec::new()));
                }

                let event = AuditEvent::new(
                    None,
                    AuditAction::new("employee.rrn_blind_index_backfill")
                        .map_err(HrError::from_kernel)?,
                    "organization",
                    org_uuid.to_string(),
                    TraceContext::generate(),
                    OffsetDateTime::now_utc(),
                )
                .with_source(AuditSource::Scheduler)
                .with_org(org)
                .with_snapshots(
                    None,
                    Some(json!({
                        "updated": updated,
                        "to_blind_index_version": target_version,
                    })),
                );
                Ok((updated, vec![event]))
            })
        })
        .await
    }
}
