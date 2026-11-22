//! IMPORT-2 (decisions #25): the sealed resident registration numbers of
//! import rows. Staged at the preview (`data_import_row_identities`, never in
//! a raw row), read as keyed hashes by the plan, and moved to `employee_rrn`
//! when the run is applied. A run never applied loses them after
//! `import.staged_identity.ttl_days` (purged at the tenant's next preview).

use std::collections::BTreeMap;

use console_hr_domain::import::rrn_value::{RrnVault, SealedRrn};
use console_hr_domain::profile::enums::IdType;
use console_hr_domain::profile::identity::infer_id_type_from_seventh;
use console_settings_domain::SettingKey;
use sqlx::Postgres;
use uuid::Uuid;

use crate::HrError;
use crate::import::caps::settings_in_tx;
pub(crate) use crate::import::identities_form::record_form;
pub use crate::import::identities_record::record;
use crate::import::sheet::StagedIdentity;

/// Legacy v1 and tenant-bound v2+ blind-index hashes of one staged row.
#[derive(Clone)]
pub struct StagedRowHashes {
    pub v1: Vec<u8>,
    pub v2: Option<Vec<u8>>,
    pub v2_candidates: Vec<Vec<u8>>,
    pub id_type: Option<String>,
    pub inferred_id_type: Option<String>,
    pub sex_fallback: Option<String>,
    pub step_up_recorded: bool,
}

pub async fn stage(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    run: Uuid,
    rows: &[StagedIdentity],
) -> Result<(), HrError> {
    for row in rows {
        let s = &row.sealed;
        sqlx::query(
            "INSERT INTO data_import_row_identities (org_id, run_id, source_key, rrn_hmac, \
               hmac_key_version, rrn_hmac_v2, blind_index_version, ciphertext, nonce, \
               dek_wrapped, dek_nonce, key_version, masked, alg_id, kek_id, msg_id, commitment_tag, id_type, source) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 'PREVIEW')",
        )
        .bind(org)
        .bind(run)
        .bind(&row.source_key)
        .bind(&s.hmac)
        .bind(s.hmac_key_version)
        .bind(s.hmac_v2.as_deref())
        .bind(s.blind_index_version)
        .bind(&s.ciphertext)
        .bind(&s.nonce)
        .bind(&s.dek_wrapped)
        .bind(&s.dek_nonce)
        .bind(s.key_version)
        .bind(&s.masked)
        .bind(s.alg_id.as_deref())
        .bind(s.kek_id.as_deref())
        .bind(s.msg_id.as_deref())
        .bind(s.commitment_tag.as_deref())
        .bind(row.id_type.as_deref())
        .execute(tx.as_mut())
        .await?;
    }
    Ok(())
}

/// Refuses a run older than the TTL key (409 `import_run_expired`).
pub async fn require_fresh_run(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    run: Uuid,
) -> Result<(), HrError> {
    let key = SettingKey::ImportStagedIdentityTtlDays;
    let days = settings_in_tx(tx, org, &[key])
        .await?
        .get(&key)
        .and_then(|v| v.as_int())
        .ok_or_else(|| HrError::internal("staged identity TTL did not resolve"))?;
    let expired: bool = sqlx::query_scalar(
        "SELECT created_at < now() - make_interval(days => $3::INT) FROM data_import_runs \
          WHERE org_id = $1 AND id = $2",
    )
    .bind(org)
    .bind(run)
    .bind(i32::try_from(days).unwrap_or(i32::MAX))
    .fetch_optional(tx.as_mut())
    .await?
    .unwrap_or(false);
    if expired {
        return Err(HrError {
            errors: None,
            status: http::StatusCode::CONFLICT,
            code: "import_run_expired",
            message: "the run is older than import.staged_identity.ttl_days; upload the file again"
                .to_owned(),
            refusals: None,
        });
    }
    Ok(())
}

/// Drops the staged identities of this tenant's runs older than the TTL key.
pub async fn purge_expired(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
) -> Result<u64, HrError> {
    let key = SettingKey::ImportStagedIdentityTtlDays;
    let days = settings_in_tx(tx, org, &[key])
        .await?
        .get(&key)
        .and_then(|v| v.as_int())
        .ok_or_else(|| HrError::internal("staged identity TTL did not resolve"))?;
    let days = i32::try_from(days).unwrap_or(i32::MAX);
    crate::import::phones::drop_staged(tx, org, None, days).await?;
    Ok(sqlx::query(
        "DELETE FROM data_import_row_identities WHERE org_id = $1 \
           AND created_at < now() - make_interval(days => $2::INT)",
    )
    .bind(org)
    .bind(days)
    .execute(tx.as_mut())
    .await?
    .rows_affected())
}

/// `source_key` -> v1 + v2+ blind-index hashes of the run's staged identities.
pub async fn run_hash_candidates(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    run: Uuid,
    vault: Option<&dyn RrnVault>,
) -> Result<BTreeMap<String, StagedRowHashes>, HrError> {
    use sqlx::Row;
    let rows = sqlx::query(
        "SELECT source_key, rrn_hmac, hmac_key_version, rrn_hmac_v2, blind_index_version, \
                ciphertext, nonce, dek_wrapped, dek_nonce, key_version, masked, \
                alg_id, kek_id, msg_id, commitment_tag, id_type, source \
         FROM data_import_row_identities WHERE org_id = $1 AND run_id = $2",
    )
    .bind(org)
    .bind(run)
    .fetch_all(tx.as_mut())
    .await?;
    let scoped = if rows.is_empty() {
        None
    } else {
        match vault {
            Some(v) => v
                .scoped_for_org(org)
                .await
                .map_err(|_| crate::rrn::unavailable())?,
            None => None,
        }
    };
    let vault = scoped.as_deref().or(vault);
    let mut out = BTreeMap::new();
    for row in &rows {
        let source_key: String = row.try_get("source_key")?;
        let id_type: Option<String> = row.try_get("id_type")?;
        let step_up_recorded =
            row.try_get::<Option<String>, _>("source")?.as_deref() == Some("STEP_UP");
        let sealed = sealed_from_row(row)?;
        let seventh = sealed
            .masked
            .as_bytes()
            .get(7)
            .and_then(|b| b.checked_sub(b'0'));
        let inferred_id_type = seventh
            .and_then(infer_id_type_from_seventh)
            .map(|t: IdType| t.as_str().to_owned());
        let sex_fallback = seventh
            .filter(|&d| matches!(d, 1..=8))
            .map(|d| if d % 2 == 1 { "MALE" } else { "FEMALE" }.to_owned());
        let v2_candidates = match vault {
            Some(v) => v
                .blind_index_v2_candidates_from_sealed(org, &sealed)
                .map_err(|_| crate::rrn::unavailable())?,
            None => sealed.hmac_v2.clone().into_iter().collect(),
        };
        let v2 = v2_candidates.first().cloned().or(sealed.hmac_v2);
        out.insert(
            source_key,
            StagedRowHashes {
                v1: sealed.hmac,
                v2,
                v2_candidates,
                id_type,
                inferred_id_type,
                sex_fallback,
                step_up_recorded,
            },
        );
    }
    Ok(out)
}

/// Serialize form and import writers: the blind-index indexes are not unique.
pub(crate) async fn lock_recording(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
) -> Result<(), HrError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("employee_rrn:{org}"))
        .execute(tx.as_mut())
        .await?;
    Ok(())
}

/// Drops what is left of the run's staged identities once settle finishes.
pub async fn drop_staged(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    run: Uuid,
) -> Result<(), HrError> {
    sqlx::query("DELETE FROM data_import_row_identities WHERE org_id = $1 AND run_id = $2")
        .bind(org)
        .bind(run)
        .execute(tx.as_mut())
        .await?;
    Ok(())
}

/// A stored sealed value (`employee_rrn` or staging row) as the vault opens it.
pub fn sealed_from_row(row: &sqlx::postgres::PgRow) -> Result<SealedRrn, HrError> {
    use sqlx::Row;
    Ok(SealedRrn {
        hmac: row.try_get("rrn_hmac")?,
        hmac_key_version: row.try_get("hmac_key_version")?,
        hmac_v2: row.try_get("rrn_hmac_v2")?,
        blind_index_version: row.try_get("blind_index_version")?,
        ciphertext: row.try_get("ciphertext")?,
        nonce: row.try_get("nonce")?,
        dek_wrapped: row.try_get("dek_wrapped")?,
        dek_nonce: row.try_get("dek_nonce")?,
        key_version: row.try_get("key_version")?,
        masked: row.try_get("masked")?,
        alg_id: row.try_get("alg_id")?,
        kek_id: row.try_get("kek_id")?,
        msg_id: row.try_get("msg_id")?,
        commitment_tag: row.try_get("commitment_tag")?,
    })
}
