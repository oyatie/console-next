// SPDX-License-Identifier: LicenseRef-Proprietary
//! Idempotent, RLS-armed, audited batched re-sealing of `employee_rrn` and
//! `data_import_row_identities` envelopes from legacy `v1`/`v2` or retired
//! KEKs onto the active `v3` AWS-ESDK-v2 suite and active KEK.

use std::collections::BTreeSet;
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

/// Aggregate counts of RRN envelopes re-sealed across durable and staged tables.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RrnResealStats {
    pub employee_rrn_updated: usize,
    pub staged_identities_updated: usize,
}

impl RrnResealStats {
    #[must_use]
    pub const fn total_updated(&self) -> usize {
        self.employee_rrn_updated + self.staged_identities_updated
    }
}

impl HrService {
    /// Discover tenants and re-seal pending `employee_rrn` and
    /// `data_import_row_identities` envelopes up to the active `v3` suite and KEK
    /// using the default worker tick limits.
    ///
    /// # Errors
    /// Only when listing organizations itself fails; per-tenant failures are
    /// logged (without RRN, ciphertext, or key material) and retried on the next run.
    pub async fn reseal_rrn_envelopes(
        &self,
        vault: Arc<dyn RrnVault>,
    ) -> Result<RrnResealStats, HrError> {
        self.reseal_rrn_envelopes_with_limits(
            vault,
            DEFAULT_BATCH_SIZE,
            MAX_BATCHES_PER_ORG_PER_TICK,
        )
        .await
    }

    /// Discover tenants and re-seal pending RRN envelopes with explicit
    /// per-tenant batch limits (`batch_size`, `max_batches`).
    pub async fn reseal_rrn_envelopes_with_limits(
        &self,
        vault: Arc<dyn RrnVault>,
        batch_size: i64,
        max_batches: usize,
    ) -> Result<RrnResealStats, HrError> {
        if vault.active_alg_id().is_none()
            || vault.active_kek_id().is_none()
            || batch_size <= 0
            || max_batches == 0
        {
            return Ok(RrnResealStats::default());
        }
        let orgs: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM platform_list_organizations()")
            // rls-arming: ok platform_list_organizations() is the SECURITY DEFINER id-only tenant discovery; every per-org statement below runs under with_org_conn / with_audits
            .fetch_all(&self.pool)
            .await?;
        let mut stats = RrnResealStats::default();
        for org_uuid in orgs {
            match self
                .reseal_rrn_envelopes_in_org(
                    OrgId::from_uuid(org_uuid),
                    vault.clone(),
                    batch_size,
                    max_batches,
                )
                .await
            {
                Ok(org_stats) => {
                    stats.employee_rrn_updated += org_stats.employee_rrn_updated;
                    stats.staged_identities_updated += org_stats.staged_identities_updated;
                }
                Err(error) => tracing::warn!(
                    org = %org_uuid,
                    error = %error.message,
                    "employee RRN envelope re-seal failed; retrying next run"
                ),
            }
        }
        Ok(stats)
    }

    /// Re-seal up to `max_batches` of size `batch_size` for both RRN tables in `org`.
    pub async fn reseal_rrn_envelopes_in_org(
        &self,
        org: OrgId,
        vault: Arc<dyn RrnVault>,
        batch_size: i64,
        max_batches: usize,
    ) -> Result<RrnResealStats, HrError> {
        if vault.active_alg_id().is_none()
            || vault.active_kek_id().is_none()
            || batch_size <= 0
            || max_batches == 0
        {
            return Ok(RrnResealStats::default());
        }
        let mut stats = RrnResealStats::default();
        for _ in 0..max_batches {
            let batch_updated = self
                .reseal_employee_rrn_batch(org, vault.clone(), batch_size)
                .await?;
            stats.employee_rrn_updated += batch_updated;
            if batch_updated == 0 {
                break;
            }
        }
        for _ in 0..max_batches {
            let batch_updated = self
                .reseal_staged_identities_batch(org, vault.clone(), batch_size)
                .await?;
            stats.staged_identities_updated += batch_updated;
            if batch_updated == 0 {
                break;
            }
        }
        Ok(stats)
    }

    /// Execute at most one bounded `FOR UPDATE SKIP LOCKED` re-seal batch on `employee_rrn`.
    pub async fn reseal_employee_rrn_batch(
        &self,
        org: OrgId,
        vault: Arc<dyn RrnVault>,
        batch_size: i64,
    ) -> Result<usize, HrError> {
        let Some(target_alg) = vault.active_alg_id().map(str::to_owned) else {
            return Ok(0);
        };
        let Some(target_kek) = vault.active_kek_id().map(str::to_owned) else {
            return Ok(0);
        };
        let target_ver = vault.active_envelope_key_version();
        if batch_size <= 0 {
            return Ok(0);
        }
        let org_uuid = *org.as_uuid();
        let probe_alg = target_alg.clone();
        let probe_kek = target_kek.clone();
        let needs_reseal: bool = with_org_conn::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                Ok(sqlx::query_scalar(
                    "SELECT EXISTS ( \
                       SELECT 1 FROM employee_rrn \
                        WHERE org_id = $1 \
                          AND (key_version <> $2 \
                               OR alg_id IS DISTINCT FROM $3 \
                               OR kek_id IS DISTINCT FROM $4) \
                     )",
                )
                .bind(org_uuid)
                .bind(target_ver)
                .bind(probe_alg)
                .bind(probe_kek)
                .fetch_one(tx.as_mut())
                .await?)
            })
        })
        .await?;
        if !needs_reseal {
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
                        AND (key_version <> $2 \
                             OR alg_id IS DISTINCT FROM $3 \
                             OR kek_id IS DISTINCT FROM $4) \
                      ORDER BY employee_id \
                      LIMIT $5 \
                      FOR UPDATE SKIP LOCKED",
                )
                .bind(org_uuid)
                .bind(target_ver)
                .bind(&target_alg)
                .bind(&target_kek)
                .bind(batch_size)
                .fetch_all(tx.as_mut())
                .await?;
                if rows.is_empty() {
                    return Ok((0, Vec::new()));
                }

                let mut employee_ids = Vec::with_capacity(rows.len());
                let mut ciphertexts = Vec::with_capacity(rows.len());
                let mut nonces = Vec::with_capacity(rows.len());
                let mut deks_wrapped = Vec::with_capacity(rows.len());
                let mut dek_nonces = Vec::with_capacity(rows.len());
                let mut key_versions = Vec::with_capacity(rows.len());
                let mut alg_ids: Vec<Option<String>> = Vec::with_capacity(rows.len());
                let mut kek_ids: Vec<Option<String>> = Vec::with_capacity(rows.len());
                let mut msg_ids: Vec<Option<Vec<u8>>> = Vec::with_capacity(rows.len());
                let mut commitment_tags: Vec<Option<Vec<u8>>> = Vec::with_capacity(rows.len());
                let mut from_key_versions = BTreeSet::new();
                let mut from_kek_ids = BTreeSet::new();

                for row in &rows {
                    let employee_id: Uuid = row.try_get("employee_id")?;
                    let sealed = sealed_from_row(row)?;
                    from_key_versions.insert(sealed.key_version);
                    if let Some(kek) = &sealed.kek_id {
                        from_kek_ids.insert(kek.clone());
                    }
                    let resealed = vault
                        .reseal(org_uuid, &sealed)
                        .map_err(|_| unavailable())?;
                    employee_ids.push(employee_id);
                    ciphertexts.push(resealed.ciphertext);
                    nonces.push(resealed.nonce);
                    deks_wrapped.push(resealed.dek_wrapped);
                    dek_nonces.push(resealed.dek_nonce);
                    key_versions.push(resealed.key_version);
                    alg_ids.push(resealed.alg_id);
                    kek_ids.push(resealed.kek_id);
                    msg_ids.push(resealed.msg_id);
                    commitment_tags.push(resealed.commitment_tag);
                }

                let result = sqlx::query(
                    "UPDATE employee_rrn AS r \
                        SET ciphertext = v.ciphertext, \
                            nonce = v.nonce, \
                            dek_wrapped = v.dek_wrapped, \
                            dek_nonce = v.dek_nonce, \
                            key_version = v.key_version, \
                            alg_id = v.alg_id, \
                            kek_id = v.kek_id, \
                            msg_id = v.msg_id, \
                            commitment_tag = v.commitment_tag \
                       FROM unnest($2::uuid[], $3::bytea[], $4::bytea[], $5::bytea[], $6::bytea[], \
                                   $7::smallint[], $8::text[], $9::text[], $10::bytea[], $11::bytea[]) \
                         AS v(employee_id, ciphertext, nonce, dek_wrapped, dek_nonce, \
                              key_version, alg_id, kek_id, msg_id, commitment_tag) \
                      WHERE r.org_id = $1 \
                        AND r.employee_id = v.employee_id \
                        AND (r.key_version <> $12 \
                             OR r.alg_id IS DISTINCT FROM $13 \
                             OR r.kek_id IS DISTINCT FROM $14)",
                )
                .bind(org_uuid)
                .bind(&employee_ids)
                .bind(&ciphertexts)
                .bind(&nonces)
                .bind(&deks_wrapped)
                .bind(&dek_nonces)
                .bind(&key_versions)
                .bind(&alg_ids)
                .bind(&kek_ids)
                .bind(&msg_ids)
                .bind(&commitment_tags)
                .bind(target_ver)
                .bind(&target_alg)
                .bind(&target_kek)
                .execute(tx.as_mut())
                .await?;
                let updated = usize::try_from(result.rows_affected()).unwrap_or(0);
                if updated == 0 {
                    return Ok((0, Vec::new()));
                }

                let event = AuditEvent::new(
                    None,
                    AuditAction::new("employee.rrn_envelope_reseal")
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
                        "table": "employee_rrn",
                        "updated": updated,
                        "from_key_versions": from_key_versions,
                        "from_kek_ids": from_kek_ids,
                        "to_key_version": target_ver,
                        "to_alg_id": target_alg,
                        "to_kek_id": target_kek,
                    })),
                );
                Ok((updated, vec![event]))
            })
        })
        .await
    }
}
