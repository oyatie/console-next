// SPDX-License-Identifier: LicenseRef-Proprietary
//! Types, step-up binding, and transaction helpers for draft row identifier entry.

use console_hr_domain::{import::rrn_value::SealedRrn, profile::enums::IdType};
use console_platform_auth::{
    MobilePasskeyStepUpBinding, MobilePasskeyStepUpEnvelope, MobileStepUpActionKind,
};
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::{HrError, digest::sha256_hex, rrn::govern};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DraftIdentifierType {
    Rrn,
    Arc,
    DomesticResidence,
}

impl From<DraftIdentifierType> for IdType {
    fn from(value: DraftIdentifierType) -> Self {
        match value {
            DraftIdentifierType::Rrn => Self::Rrn,
            DraftIdentifierType::Arc => Self::Arc,
            DraftIdentifierType::DomesticResidence => Self::DomesticResidence,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportRowIdentifierRequest {
    pub rrn: String,
    #[serde(default)]
    pub id_type: Option<DraftIdentifierType>,
    #[serde(default)]
    pub step_up: Option<MobilePasskeyStepUpEnvelope>,
}

impl std::fmt::Debug for ImportRowIdentifierRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ImportRowIdentifierRequest([redacted])")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImportRowIdentifierResponse {
    pub run_id: Uuid,
    pub source_key: String,
    pub id_type: String,
    pub recorded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sex_derived: Option<String>,
}

/// Passkey step-up binding for recording an identifier onto a staged import draft row.
#[must_use]
pub fn import_row_identifier_binding(run_id: Uuid, source_key: &str) -> MobilePasskeyStepUpBinding {
    MobilePasskeyStepUpBinding::bound(
        MobileStepUpActionKind::PiiRecord,
        run_id,
        sha256_hex(format!("{run_id}:{source_key}").as_bytes()),
    )
}

pub(super) async fn write_staged_step_up_identity_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_uuid: Uuid,
    run_id: Uuid,
    source_key: &str,
    sealed: &SealedRrn,
    candidates: &[Vec<u8>],
    stored_id_type: &str,
) -> Result<(), HrError> {
    let has_v2 = !candidates.is_empty();
    crate::import::identities::lock_recording(tx, org_uuid).await?;
    let in_run_conflict: bool = sqlx::query_scalar(
        "SELECT EXISTS ( \
           SELECT 1 FROM data_import_row_identities \
           WHERE org_id = $1 AND run_id = $2 AND source_key <> $3 \
             AND ((rrn_hmac_v2 IS NOT NULL AND rrn_hmac_v2 = ANY($4)) \
                  OR ((rrn_hmac_v2 IS NULL OR NOT $6) AND rrn_hmac = $5)) \
         )",
    )
    .bind(org_uuid)
    .bind(run_id)
    .bind(source_key)
    .bind(candidates)
    .bind(&sealed.hmac)
    .bind(has_v2)
    .fetch_one(tx.as_mut())
    .await?;
    if in_run_conflict {
        return Err(govern::refused(
            http::StatusCode::CONFLICT,
            "rrn_in_use",
            "resident registration number is already in use",
        ));
    }
    sqlx::query(
        "DELETE FROM data_import_row_identities \
         WHERE org_id = $1 AND run_id = $2 AND source_key = $3",
    )
    .bind(org_uuid)
    .bind(run_id)
    .bind(source_key)
    .execute(tx.as_mut())
    .await?;
    sqlx::query(
        "INSERT INTO data_import_row_identities (org_id, run_id, source_key, rrn_hmac, \
           hmac_key_version, rrn_hmac_v2, blind_index_version, ciphertext, nonce, \
           dek_wrapped, dek_nonce, key_version, masked, alg_id, kek_id, msg_id, commitment_tag, id_type, source) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'STEP_UP')",
    )
    .bind(org_uuid)
    .bind(run_id)
    .bind(source_key)
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
    .bind(stored_id_type)
    .execute(tx.as_mut())
    .await?;
    let existing_decisions: Option<serde_json::Value> = sqlx::query_scalar(
        "SELECT dry_run_decisions FROM data_import_runs WHERE org_id = $1 AND id = $2",
    )
    .bind(org_uuid)
    .bind(run_id)
    .fetch_optional(tx.as_mut())
    .await?
    .flatten();
    if let Some(mut decisions_val) = existing_decisions
        && let Some(cells_obj) = decisions_val
            .get_mut("cells")
            .and_then(|v| v.as_object_mut())
        && let Some(row_cells) = cells_obj
            .get_mut(source_key)
            .and_then(|v| v.as_object_mut())
        && row_cells.remove("id_type").is_some()
    {
        if row_cells.is_empty() {
            cells_obj.remove(source_key);
        }
        sqlx::query(
            "UPDATE data_import_runs SET dry_run_decisions = $3, updated_at = now() \
             WHERE org_id = $1 AND id = $2",
        )
        .bind(org_uuid)
        .bind(run_id)
        .bind(decisions_val)
        .execute(tx.as_mut())
        .await?;
    }
    Ok(())
}
