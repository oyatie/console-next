// SPDX-License-Identifier: LicenseRef-Proprietary
//! IMPORT-2: promotion and form-entry recording for sealed RRNs with dual-read
//! conflict checks across v1 and tenant-bound v2+ blind indexes.

use std::collections::BTreeMap;

use console_hr_domain::import::rrn_value::{RrnVault, SealedRrn};
use sqlx::Postgres;
use uuid::Uuid;

use super::identities::{lock_recording, sealed_from_row};
use crate::HrError;

/// Moves the run's staged identities to the people the run inserted or
/// matched (`source_key` -> employee). Returns how many were recorded.
pub async fn record(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    actor: Uuid,
    run: Uuid,
    people: &BTreeMap<String, Uuid>,
    vault: Option<&dyn RrnVault>,
) -> Result<usize, HrError> {
    lock_recording(tx, org).await?;
    let keys: Vec<&String> = people.keys().collect();
    let employees: Vec<Uuid> = people.values().copied().collect();
    if has_record_conflict(tx, org, run, &keys, people, vault).await? {
        return Err(HrError::from_kernel(
            console_kernel_core::KernelError::conflict(
                "resident registration number is already in use",
            )
            .with_code("rrn_in_use"),
        ));
    }
    let count: i64 = sqlx::query_scalar(
        "WITH recorded AS ( \
         INSERT INTO employee_rrn (org_id, employee_id, rrn_hmac, hmac_key_version, \
           rrn_hmac_v2, blind_index_version, ciphertext, nonce, dek_wrapped, dek_nonce, \
           key_version, masked, alg_id, kek_id, msg_id, commitment_tag, source, import_run_id, \
           recorded_by) \
         SELECT s.org_id, p.employee, s.rrn_hmac, s.hmac_key_version, s.rrn_hmac_v2, \
                s.blind_index_version, s.ciphertext, s.nonce, s.dek_wrapped, s.dek_nonce, \
                s.key_version, s.masked, s.alg_id, s.kek_id, s.msg_id, s.commitment_tag, \
                'IMPORT', s.run_id, $5 \
         FROM unnest($3::TEXT[], $4::UUID[]) WITH ORDINALITY p(source_key, employee, n) \
         JOIN data_import_row_identities s ON s.source_key = p.source_key \
         WHERE s.org_id = $1 AND s.run_id = $2 ORDER BY p.n \
         ON CONFLICT (org_id, employee_id) DO NOTHING RETURNING org_id, employee_id) \
         , effects AS (INSERT INTO import_run_effects (org_id, run_id, employee_id, effect, target_id) \
         SELECT org_id, $2, employee_id, 'rrn_recorded', employee_id FROM recorded \
         ON CONFLICT (org_id, run_id, employee_id, effect, target_id) DO NOTHING RETURNING 1) \
         SELECT count(*) FROM recorded",
    )
    .bind(org)
    .bind(run)
    .bind(&keys)
    .bind(&employees)
    .bind(actor)
    .fetch_one(tx.as_mut())
    .await?;
    let recorded = usize::try_from(count).unwrap_or(0);
    sqlx::query(
        "DELETE FROM data_import_row_identities \
          WHERE org_id = $1 AND run_id = $2 AND source_key = ANY($3)",
    )
    .bind(org)
    .bind(run)
    .bind(&keys)
    .execute(tx.as_mut())
    .await?;
    Ok(recorded)
}

async fn has_record_conflict(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    run: Uuid,
    keys: &[&String],
    people: &BTreeMap<String, Uuid>,
    vault: Option<&dyn RrnVault>,
) -> Result<bool, HrError> {
    use sqlx::Row;
    let staged_rows = sqlx::query(
        "SELECT source_key, rrn_hmac, hmac_key_version, rrn_hmac_v2, blind_index_version, \
                ciphertext, nonce, dek_wrapped, dek_nonce, key_version, masked, \
                alg_id, kek_id, msg_id, commitment_tag \
         FROM data_import_row_identities \
         WHERE org_id = $1 AND run_id = $2 AND source_key = ANY($3)",
    )
    .bind(org)
    .bind(run)
    .bind(keys)
    .fetch_all(tx.as_mut())
    .await?;
    if staged_rows.is_empty() {
        return Ok(false);
    }

    let mut v2_employees: Vec<Uuid> = Vec::new();
    let mut v2_hashes: Vec<Vec<u8>> = Vec::new();
    let mut v1_employees: Vec<Uuid> = Vec::new();
    let mut v1_hashes: Vec<Vec<u8>> = Vec::new();
    let mut v1_has_v2: Vec<bool> = Vec::new();

    for row in &staged_rows {
        let source_key: String = row.try_get("source_key")?;
        let Some(&employee) = people.get(&source_key) else {
            continue;
        };
        let sealed = sealed_from_row(row)?;
        let candidates = match vault {
            Some(v) => v
                .blind_index_v2_candidates_from_sealed(org, &sealed)
                .map_err(|_| crate::rrn::unavailable())?,
            None => sealed.hmac_v2.clone().into_iter().collect(),
        };
        let has_v2 = !candidates.is_empty();
        for candidate in candidates {
            v2_employees.push(employee);
            v2_hashes.push(candidate);
        }
        v1_employees.push(employee);
        v1_hashes.push(sealed.hmac);
        v1_has_v2.push(has_v2);
    }

    let conflict: bool = sqlx::query_scalar(
        "SELECT EXISTS( \
           SELECT 1 FROM unnest($2::uuid[], $3::bytea[]) p(employee, candidate_hmac) \
           JOIN employee_rrn r ON r.org_id = $1 \
            AND r.rrn_hmac_v2 IS NOT NULL \
            AND r.rrn_hmac_v2 = p.candidate_hmac \
            AND r.employee_id <> p.employee \
         ) OR EXISTS( \
           SELECT 1 FROM unnest($4::uuid[], $5::bytea[], $6::bool[]) p(employee, v1_hmac, has_v2) \
           JOIN employee_rrn r ON r.org_id = $1 \
            AND (r.rrn_hmac_v2 IS NULL OR NOT p.has_v2) \
            AND r.rrn_hmac = p.v1_hmac \
            AND r.employee_id <> p.employee \
         )",
    )
    .bind(org)
    .bind(&v2_employees)
    .bind(&v2_hashes)
    .bind(&v1_employees)
    .bind(&v1_hashes)
    .bind(&v1_has_v2)
    .fetch_one(tx.as_mut())
    .await?;
    Ok(conflict)
}

/// The form command uses the import identity writer and its tenant-wide claim lock.
pub(crate) async fn record_form(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    actor: Uuid,
    employee: Uuid,
    sealed: SealedRrn,
    v2_candidates: &[Vec<u8>],
) -> Result<time::OffsetDateTime, HrError> {
    use crate::rrn::govern;
    lock_recording(tx, org).await?;
    let mut candidates = v2_candidates.to_vec();
    if let Some(primary) = &sealed.hmac_v2
        && !candidates.iter().any(|c| c == primary)
    {
        candidates.insert(0, primary.clone());
    }
    let has_v2 = !candidates.is_empty();
    let (recorded, in_use): (bool, bool) = sqlx::query_as(
        "SELECT EXISTS(SELECT 1 FROM employee_rrn WHERE org_id=$1 AND employee_id=$2), \
         EXISTS(SELECT 1 FROM employee_rrn WHERE org_id=$1 \
                AND ((rrn_hmac_v2 IS NOT NULL AND rrn_hmac_v2 = ANY($3)) \
                     OR ((rrn_hmac_v2 IS NULL OR NOT $5) AND rrn_hmac = $4)))",
    )
    .bind(org)
    .bind(employee)
    .bind(&candidates)
    .bind(&sealed.hmac)
    .bind(has_v2)
    .fetch_one(tx.as_mut())
    .await?;
    if recorded || in_use {
        let (code, message) = if recorded {
            (
                "rrn_already_recorded",
                "resident registration number is already recorded",
            )
        } else {
            (
                "rrn_in_use",
                "resident registration number is already in use",
            )
        };
        return Err(govern::refused(http::StatusCode::CONFLICT, code, message));
    }
    let recorded_at = sqlx::query_scalar(
        "INSERT INTO employee_rrn(org_id,employee_id,rrn_hmac,hmac_key_version,\
         rrn_hmac_v2,blind_index_version,ciphertext,nonce,dek_wrapped,dek_nonce,\
         key_version,masked,alg_id,kek_id,msg_id,commitment_tag,source,recorded_by) \
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'FORM',$17) \
         RETURNING recorded_at",
    )
    .bind(org)
    .bind(employee)
    .bind(&sealed.hmac)
    .bind(sealed.hmac_key_version)
    .bind(sealed.hmac_v2.as_deref())
    .bind(sealed.blind_index_version)
    .bind(&sealed.ciphertext)
    .bind(&sealed.nonce)
    .bind(&sealed.dek_wrapped)
    .bind(&sealed.dek_nonce)
    .bind(sealed.key_version)
    .bind(&sealed.masked)
    .bind(sealed.alg_id.as_deref())
    .bind(sealed.kek_id.as_deref())
    .bind(sealed.msg_id.as_deref())
    .bind(sealed.commitment_tag.as_deref())
    .bind(actor)
    .fetch_one(tx.as_mut())
    .await?;
    Ok(recorded_at)
}
