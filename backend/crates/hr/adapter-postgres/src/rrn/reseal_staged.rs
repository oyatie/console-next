// SPDX-License-Identifier: LicenseRef-Proprietary
//! Idempotent, RLS-armed, audited batched re-sealing of staged `data_import_row_identities`
//! envelopes, preserving `("employee_rrn", "rrn")` AAD so promotion into `employee_rrn`
//! remains decryptable across rotations.

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

impl HrService {
    /// Execute at most one bounded `FOR UPDATE SKIP LOCKED` re-seal batch on
    /// `data_import_row_identities`.
    pub async fn reseal_staged_identities_batch(
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
                       SELECT 1 FROM data_import_row_identities \
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
                    "SELECT run_id, source_key, rrn_hmac, hmac_key_version, rrn_hmac_v2, \
                            blind_index_version, ciphertext, nonce, dek_wrapped, dek_nonce, \
                            key_version, masked, alg_id, kek_id, msg_id, commitment_tag \
                       FROM data_import_row_identities \
                      WHERE org_id = $1 \
                        AND (key_version <> $2 \
                             OR alg_id IS DISTINCT FROM $3 \
                             OR kek_id IS DISTINCT FROM $4) \
                      ORDER BY run_id, source_key \
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

                let mut run_ids = Vec::with_capacity(rows.len());
                let mut source_keys = Vec::with_capacity(rows.len());
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
                    let run_id: Uuid = row.try_get("run_id")?;
                    let source_key: String = row.try_get("source_key")?;
                    let sealed = sealed_from_row(row)?;
                    from_key_versions.insert(sealed.key_version);
                    if let Some(kek) = &sealed.kek_id {
                        from_kek_ids.insert(kek.clone());
                    }
                    let resealed = vault.reseal(org_uuid, &sealed).map_err(|_| unavailable())?;
                    run_ids.push(run_id);
                    source_keys.push(source_key);
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
                    "UPDATE data_import_row_identities AS r \
                        SET ciphertext = v.ciphertext, \
                            nonce = v.nonce, \
                            dek_wrapped = v.dek_wrapped, \
                            dek_nonce = v.dek_nonce, \
                            key_version = v.key_version, \
                            alg_id = v.alg_id, \
                            kek_id = v.kek_id, \
                            msg_id = v.msg_id, \
                            commitment_tag = v.commitment_tag \
                       FROM unnest($2::uuid[], $3::text[], $4::bytea[], $5::bytea[], $6::bytea[], \
                                   $7::bytea[], $8::smallint[], $9::text[], $10::text[], \
                                   $11::bytea[], $12::bytea[]) \
                         AS v(run_id, source_key, ciphertext, nonce, dek_wrapped, dek_nonce, \
                              key_version, alg_id, kek_id, msg_id, commitment_tag) \
                      WHERE r.org_id = $1 \
                        AND r.run_id = v.run_id \
                        AND r.source_key = v.source_key \
                        AND (r.key_version <> $13 \
                             OR r.alg_id IS DISTINCT FROM $14 \
                             OR r.kek_id IS DISTINCT FROM $15)",
                )
                .bind(org_uuid)
                .bind(&run_ids)
                .bind(&source_keys)
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
                    AuditAction::new("import.staged_identity_envelope_reseal")
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
                        "table": "data_import_row_identities",
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
