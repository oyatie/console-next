//! IMPORT-2 (decisions #25): the sealed 주민등록번호 of import rows. Staged
//! at the preview (`data_import_row_identities`, never in a raw row), read as
//! keyed hashes by the plan, and moved to `employee_rrn` when the run is
//! applied. A run never applied loses them after
//! `import.staged_identity.ttl_days` (purged at the tenant's next preview).

use std::collections::BTreeMap;

use console_hr_domain::import::rrn_value::SealedRrn;
use console_settings_domain::SettingKey;
use sqlx::Postgres;
use uuid::Uuid;

use crate::HrError;
use crate::import::caps::settings_in_tx;
use crate::import::sheet::StagedIdentity;

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
               hmac_key_version, ciphertext, nonce, dek_wrapped, dek_nonce, key_version, masked) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
        )
        .bind(org)
        .bind(run)
        .bind(&row.source_key)
        .bind(&s.hmac)
        .bind(s.hmac_key_version)
        .bind(&s.ciphertext)
        .bind(&s.nonce)
        .bind(&s.dek_wrapped)
        .bind(&s.dek_nonce)
        .bind(s.key_version)
        .bind(&s.masked)
        .execute(tx.as_mut())
        .await?;
    }
    Ok(())
}

/// Refuses a run older than the TTL key (409 `import_run_expired`): its
/// staged identities are (or will be) purged, so planning or applying it
/// would silently lose them. Re-upload the file instead.
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

/// Drops the staged identities of this tenant's runs older than the TTL key
/// (such runs are refused by [`require_fresh_run`]).
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
    // W12: the staged 휴대전화 of such runs go with them.
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

/// `source_key` → keyed hash of the run's staged identities.
pub async fn run_hashes(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    run: Uuid,
) -> Result<BTreeMap<String, Vec<u8>>, HrError> {
    let rows: Vec<(String, Vec<u8>)> = sqlx::query_as(
        "SELECT source_key, rrn_hmac FROM data_import_row_identities WHERE org_id = $1 AND run_id = $2",
    )
    .bind(org)
    .bind(run)
    .fetch_all(tx.as_mut())
    .await?;
    Ok(rows.into_iter().collect())
}

/// Moves the run's staged identities to the people the run inserted or
/// matched (`source_key` → employee). A person who already has one keeps it
/// (a different one is the plan's `identity_mismatch`). Returns how many
/// were recorded.
pub async fn record(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    actor: Uuid,
    run: Uuid,
    people: &BTreeMap<String, Uuid>,
) -> Result<usize, HrError> {
    lock_recording(tx, org).await?;
    let keys: Vec<&String> = people.keys().collect();
    let employees: Vec<Uuid> = people.values().copied().collect();
    let conflict: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM unnest($3::text[], $4::uuid[]) p(source_key,employee) \
         JOIN data_import_row_identities s ON s.org_id=$1 AND s.run_id=$2 AND s.source_key=p.source_key \
         JOIN employee_rrn r ON r.org_id=s.org_id AND r.rrn_hmac=s.rrn_hmac AND r.employee_id<>p.employee)",
    ).bind(org).bind(run).bind(&keys).bind(&employees).fetch_one(tx.as_mut()).await?;
    if conflict {
        return Err(HrError::from_kernel(
            console_kernel_core::KernelError::conflict(
                "resident registration number is already in use",
            )
            .with_code("rrn_in_use"),
        ));
    }
    let count: i64 = sqlx::query_scalar(
        "WITH recorded AS ( \
         INSERT INTO employee_rrn (org_id, employee_id, rrn_hmac, hmac_key_version, ciphertext, \
           nonce, dek_wrapped, dek_nonce, key_version, masked, source, import_run_id, recorded_by) \
         SELECT s.org_id, p.employee, s.rrn_hmac, s.hmac_key_version, s.ciphertext, s.nonce, \
                s.dek_wrapped, s.dek_nonce, s.key_version, s.masked, 'IMPORT', s.run_id, $5 \
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

/// The form command uses the import identity writer and its tenant-wide claim lock.
pub(crate) async fn record_form(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    actor: Uuid,
    employee: Uuid,
    sealed: SealedRrn,
) -> Result<time::OffsetDateTime, HrError> {
    use crate::rrn::govern;
    let hmac = &sealed.hmac;
    lock_recording(tx, org).await?;
    let (recorded, in_use): (bool, bool) = sqlx::query_as(
        "SELECT EXISTS(SELECT 1 FROM employee_rrn WHERE org_id=$1 AND employee_id=$2), \
         EXISTS(SELECT 1 FROM employee_rrn WHERE org_id=$1 AND rrn_hmac=$3)",
    )
    .bind(org)
    .bind(employee)
    .bind(hmac)
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
    let recorded_at = sqlx::query_scalar("INSERT INTO employee_rrn(org_id,employee_id,rrn_hmac,hmac_key_version,ciphertext,nonce,dek_wrapped,dek_nonce,key_version,masked,source,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'FORM',$11) RETURNING recorded_at")
                .bind(org).bind(employee).bind(hmac).bind(sealed.hmac_key_version).bind(sealed.ciphertext)
                .bind(sealed.nonce).bind(sealed.dek_wrapped).bind(sealed.dek_nonce).bind(sealed.key_version).bind(sealed.masked).bind(actor)
                .fetch_one(tx.as_mut()).await?;
    Ok(recorded_at)
}

/// Serialize form and import writers: the legacy blind-index index is not unique.
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

/// Drops what is left of the run's staged identities (rows the run left out),
/// once its last settle chunk has recorded the rest.
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

/// A stored sealed value (employee_rrn or staging row) as the vault opens it.
pub fn sealed_from_row(row: &sqlx::postgres::PgRow) -> Result<SealedRrn, HrError> {
    use sqlx::Row;
    Ok(SealedRrn {
        hmac: row.try_get("rrn_hmac")?,
        hmac_key_version: row.try_get("hmac_key_version")?,
        ciphertext: row.try_get("ciphertext")?,
        nonce: row.try_get("nonce")?,
        dek_wrapped: row.try_get("dek_wrapped")?,
        dek_nonce: row.try_get("dek_nonce")?,
        key_version: row.try_get("key_version")?,
        masked: row.try_get("masked")?,
    })
}
