// SPDX-License-Identifier: LicenseRef-Proprietary
//! Form-entry sealed RRN persistence using the import identity claim lock.

use console_hr_domain::import::rrn_value::SealedRrn;
use sqlx::Postgres;
use uuid::Uuid;

use super::identities::lock_recording;
use crate::HrError;

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
