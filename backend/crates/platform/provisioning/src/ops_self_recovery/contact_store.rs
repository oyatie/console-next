// SPDX-License-Identifier: LicenseRef-Proprietary
//! PostgreSQL persistence and AWS-ESDK-v2 (`alg_id = 3`) seal/open operations
//! for `recovery_contacts`.

use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use console_platform_crypto::{
    AlgId, COMMITMENT_TAG_LEN, EnvelopeHeader, KekId, MSG_ID_LEN, NONCE_LEN, SealedEnvelope,
    open_v3, seal_v3,
};
use console_platform_db::with_audits;
use secrecy::{ExposeSecret, SecretString};
use sqlx::{PgPool, Postgres, Row, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::ProvisioningError;
use crate::ops_self_recovery::crypto::{
    ALG_WIRE, RECOVERY_CONTACT_NOTICE_VERSION, RecoveryChannel, RecoveryContactCipher,
    RecoveryContactStatus, envelope_ctx, mask_recovery_contact, normalize_and_validate_contact,
};

pub async fn load_recovery_contact_status_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    user_id: Uuid,
) -> Result<Option<RecoveryContactStatus>, ProvisioningError> {
    let row = sqlx::query(
        "SELECT channel, masked_value, confirmed_at, notice_version
           FROM recovery_contacts
          WHERE org_id = $1 AND user_id = $2",
    )
    .bind(org.as_uuid())
    .bind(user_id)
    .fetch_optional(tx.as_mut())
    .await?;
    let Some(row) = row else { return Ok(None) };
    let channel_raw: String = row.try_get("channel")?;
    Ok(Some(RecoveryContactStatus {
        channel: RecoveryChannel::parse(&channel_raw)?,
        masked_value: row.try_get("masked_value")?,
        confirmed_at: row.try_get("confirmed_at")?,
        notice_version: row.try_get("notice_version")?,
        review_pending: true,
    }))
}

pub async fn decrypt_recovery_contact_tx(
    tx: &mut Transaction<'_, Postgres>,
    cipher: &RecoveryContactCipher,
    org: OrgId,
    user_id: Uuid,
) -> Result<Option<(RecoveryChannel, SecretString, String)>, ProvisioningError> {
    let row = sqlx::query(
        "SELECT id, channel, masked_value, kek_id, msg_id, commitment_tag, nonce, dek_wrapped, ciphertext
           FROM recovery_contacts
          WHERE org_id = $1 AND user_id = $2",
    )
    .bind(org.as_uuid())
    .bind(user_id)
    .fetch_optional(tx.as_mut())
    .await?;
    let Some(row) = row else { return Ok(None) };
    let id: Uuid = row.try_get("id")?;
    let channel = RecoveryChannel::parse(&row.try_get::<String, _>("channel")?)?;
    let masked_value: String = row.try_get("masked_value")?;
    let msg_id: [u8; MSG_ID_LEN] = row
        .try_get::<Vec<u8>, _>("msg_id")?
        .try_into()
        .map_err(|_| ProvisioningError::Conflict("corrupt recovery msg_id".to_owned()))?;
    let commitment_tag: [u8; COMMITMENT_TAG_LEN] = row
        .try_get::<Vec<u8>, _>("commitment_tag")?
        .try_into()
        .map_err(|_| ProvisioningError::Conflict("corrupt recovery commitment_tag".to_owned()))?;
    let nonce: [u8; NONCE_LEN] = row
        .try_get::<Vec<u8>, _>("nonce")?
        .try_into()
        .map_err(|_| ProvisioningError::Conflict("corrupt recovery nonce".to_owned()))?;
    let kek_id = KekId::new(row.try_get::<String, _>("kek_id")?)
        .map_err(|_| ProvisioningError::Conflict("corrupt recovery kek_id".to_owned()))?;
    let sealed = SealedEnvelope {
        header: EnvelopeHeader {
            wire_version: 1,
            alg_id: AlgId::AwsEsdkV2Aes256GcmHkdfSha256CommitKeyWrap,
            kek_id,
            msg_id,
            commitment_tag,
            nonce,
            wrapped_dek: row.try_get("dek_wrapped")?,
        },
        ciphertext: row.try_get("ciphertext")?,
    };
    let org_s = org.as_uuid().to_string();
    let rec_s = id.to_string();
    let plain = open_v3(cipher.kms()?, envelope_ctx(&org_s, &rec_s), &sealed).map_err(|_| {
        ProvisioningError::Conflict("failed to decrypt recovery contact".to_owned())
    })?;
    let text = String::from_utf8(plain.expose_secret().clone()).map_err(|_| {
        ProvisioningError::Conflict("recovery contact plaintext invalid UTF-8".to_owned())
    })?;
    Ok(Some((channel, SecretString::from(text), masked_value)))
}

pub async fn upsert_recovery_contact_tx(
    tx: &mut Transaction<'_, Postgres>,
    cipher: &RecoveryContactCipher,
    org: OrgId,
    user_id: Uuid,
    channel: RecoveryChannel,
    raw_value: &str,
    now: OffsetDateTime,
) -> Result<(RecoveryContactStatus, AuditEvent), ProvisioningError> {
    let is_ops: Option<bool> = sqlx::query_scalar(
        "SELECT is_tenant_ops AND is_active FROM users WHERE org_id = $1 AND id = $2 FOR SHARE",
    )
    .bind(org.as_uuid())
    .bind(user_id)
    .fetch_optional(tx.as_mut())
    .await?;
    if is_ops != Some(true) {
        return Err(ProvisioningError::Forbidden("ops_holder_only".to_owned()));
    }
    let normalized = normalize_and_validate_contact(channel, raw_value)?;
    let masked = mask_recovery_contact(channel, &normalized);
    let existing_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM recovery_contacts WHERE org_id = $1 AND user_id = $2 FOR UPDATE",
    )
    .bind(org.as_uuid())
    .bind(user_id)
    .fetch_optional(tx.as_mut())
    .await?;
    let record_id = existing_id.unwrap_or_else(Uuid::new_v4);
    let org_s = org.as_uuid().to_string();
    let rec_s = record_id.to_string();
    let sealed = seal_v3(
        cipher.kms()?,
        envelope_ctx(&org_s, &rec_s),
        normalized.as_bytes(),
    )
    .map_err(|_| ProvisioningError::Conflict("failed to encrypt recovery contact".to_owned()))?;

    sqlx::query(
        "INSERT INTO recovery_contacts (
            org_id, id, user_id, channel, masked_value, alg_id, kek_id, key_version,
            msg_id, commitment_tag, nonce, dek_wrapped, ciphertext, notice_version, confirmed_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 3, $8, $9, $10, $11, $12, $13, $14, $14)
         ON CONFLICT (org_id, user_id) DO UPDATE SET
            channel = EXCLUDED.channel, masked_value = EXCLUDED.masked_value,
            alg_id = EXCLUDED.alg_id, kek_id = EXCLUDED.kek_id, key_version = 3,
            msg_id = EXCLUDED.msg_id, commitment_tag = EXCLUDED.commitment_tag,
            nonce = EXCLUDED.nonce, dek_wrapped = EXCLUDED.dek_wrapped,
            ciphertext = EXCLUDED.ciphertext, notice_version = EXCLUDED.notice_version,
            confirmed_at = EXCLUDED.confirmed_at, updated_at = EXCLUDED.updated_at",
    )
    .bind(org.as_uuid())
    .bind(record_id)
    .bind(user_id)
    .bind(channel.as_str())
    .bind(&masked)
    .bind(ALG_WIRE)
    .bind(sealed.header.kek_id.as_str())
    .bind(sealed.header.msg_id.as_slice())
    .bind(sealed.header.commitment_tag.as_slice())
    .bind(sealed.header.nonce.as_slice())
    .bind(&sealed.header.wrapped_dek)
    .bind(&sealed.ciphertext)
    .bind(RECOVERY_CONTACT_NOTICE_VERSION)
    .bind(now)
    .execute(tx.as_mut())
    .await?;

    let status = RecoveryContactStatus {
        channel,
        masked_value: masked,
        confirmed_at: now,
        notice_version: RECOVERY_CONTACT_NOTICE_VERSION.to_owned(),
        review_pending: true,
    };
    let event = AuditEvent::new(
        Some(UserId::from_uuid(user_id)),
        AuditAction::new("auth.recovery_contact.upsert")?,
        "recovery_contact",
        record_id.to_string(),
        TraceContext::generate(),
        now,
    )
    .with_org(org)
    .with_snapshots(
        None,
        Some(serde_json::json!({
            "channel": channel.as_str(),
            "notice_version": RECOVERY_CONTACT_NOTICE_VERSION,
        })),
    );
    Ok((status, event))
}

pub async fn upsert_recovery_contact(
    pool: &PgPool,
    cipher: &RecoveryContactCipher,
    org: OrgId,
    user_id: Uuid,
    channel: RecoveryChannel,
    raw_value: &str,
    now: OffsetDateTime,
) -> Result<RecoveryContactStatus, ProvisioningError> {
    let cipher = cipher.clone();
    let raw_owned = raw_value.to_owned();
    with_audits::<_, RecoveryContactStatus, ProvisioningError>(pool, org, move |tx| {
        Box::pin(async move {
            let (status, event) =
                upsert_recovery_contact_tx(tx, &cipher, org, user_id, channel, &raw_owned, now)
                    .await?;
            Ok((status, vec![event]))
        })
    })
    .await
}
