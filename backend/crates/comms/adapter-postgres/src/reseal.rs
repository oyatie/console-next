// SPDX-License-Identifier: LicenseRef-Proprietary
//! Idempotent, RLS-armed, audited batched re-sealing for `email_accounts`
//! SMTP and IMAP credential envelopes.

use std::sync::Arc;

use console_comms_application::{Aad, CredentialCipher, SealedCredential};
use console_kernel_core::{
    AuditAction, AuditEvent, AuditSource, KernelError, OrgId, Timestamp, TraceContext,
};
use console_platform_db::{with_audits, with_org_conn};
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::{PgMailError, PgMailStore};

/// Aggregate counts of SMTP/IMAP credentials re-sealed on `email_accounts`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EmailResealStats {
    pub accounts_updated: usize,
    pub smtp_resealed: usize,
    pub imap_resealed: usize,
}

fn envelope_needs_reseal(env: &SealedCredential, target_alg: &str, target_kek: &str) -> bool {
    env.key_version != 3
        || env.alg_id.as_deref() != Some(target_alg)
        || env.kek_id.as_deref() != Some(target_kek)
}

fn cipher_err_to_mail() -> PgMailError {
    PgMailError::Domain(KernelError::internal("credential cipher re-seal failed"))
}

fn sealed_slot(
    row: &sqlx::postgres::PgRow,
    is_imap: bool,
) -> Result<SealedCredential, sqlx::Error> {
    if is_imap {
        Ok(SealedCredential {
            ciphertext: row.try_get("imap_password_ct")?,
            nonce: row.try_get("imap_password_nonce")?,
            dek_wrapped: row.try_get("imap_dek_wrapped")?,
            dek_nonce: row.try_get("imap_dek_nonce")?,
            key_version: row.try_get("imap_key_version")?,
            alg_id: row.try_get("imap_alg_id")?,
            kek_id: row.try_get("imap_kek_id")?,
            msg_id: row.try_get("imap_msg_id")?,
            commitment_tag: row.try_get("imap_commitment_tag")?,
        })
    } else {
        Ok(SealedCredential {
            ciphertext: row.try_get("smtp_password_ct")?,
            nonce: row.try_get("smtp_password_nonce")?,
            dek_wrapped: row.try_get("dek_wrapped")?,
            dek_nonce: row.try_get("dek_nonce")?,
            key_version: row.try_get("key_version")?,
            alg_id: row.try_get("alg_id")?,
            kek_id: row.try_get("kek_id")?,
            msg_id: row.try_get("smtp_msg_id")?,
            commitment_tag: row.try_get("smtp_commitment_tag")?,
        })
    }
}

async fn update_slot_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org_uuid: Uuid,
    account_id: Uuid,
    is_imap: bool,
    fresh: &SealedCredential,
) -> Result<(), sqlx::Error> {
    let sql = if is_imap {
        "UPDATE email_accounts SET imap_password_ct = $3, imap_password_nonce = $4, \
         imap_dek_wrapped = $5, imap_dek_nonce = $6, imap_key_version = $7, \
         imap_alg_id = $8, imap_kek_id = $9, imap_msg_id = $10, \
         imap_commitment_tag = $11, updated_at = now() WHERE org_id = $1 AND id = $2"
    } else {
        "UPDATE email_accounts SET smtp_password_ct = $3, smtp_password_nonce = $4, \
         dek_wrapped = $5, dek_nonce = $6, key_version = $7, \
         alg_id = $8, kek_id = $9, smtp_msg_id = $10, \
         smtp_commitment_tag = $11, updated_at = now() WHERE org_id = $1 AND id = $2"
    };
    sqlx::query(sql)
        .bind(org_uuid)
        .bind(account_id)
        .bind(&fresh.ciphertext)
        .bind(&fresh.nonce)
        .bind(&fresh.dek_wrapped)
        .bind(&fresh.dek_nonce)
        .bind(fresh.key_version)
        .bind(fresh.alg_id.as_deref())
        .bind(fresh.kek_id.as_deref())
        .bind(fresh.msg_id.as_deref())
        .bind(fresh.commitment_tag.as_deref())
        .execute(tx.as_mut())
        .await?;
    Ok(())
}

impl PgMailStore {
    /// Discover tenants and re-seal pending `email_accounts` SMTP/IMAP credentials.
    pub async fn reseal_email_accounts(
        &self,
        cipher: Arc<dyn CredentialCipher>,
        batch_size: i64,
        max_batches: usize,
    ) -> Result<EmailResealStats, PgMailError> {
        if cipher.active_alg_id().is_none()
            || cipher.active_kek_id().is_none()
            || batch_size <= 0
            || max_batches == 0
        {
            return Ok(EmailResealStats::default());
        }
        let orgs: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM platform_list_organizations()")
            // rls-arming: ok platform_list_organizations() is the SECURITY DEFINER id-only tenant discovery; every per-org statement below runs under with_org_conn / with_audits
            .fetch_all(&self.pool)
            .await?;
        let mut total = EmailResealStats::default();
        for org_uuid in orgs {
            match self
                .reseal_email_accounts_in_org(
                    OrgId::from_uuid(org_uuid),
                    cipher.clone(),
                    batch_size,
                    max_batches,
                )
                .await
            {
                Ok(stats) => {
                    total.accounts_updated += stats.accounts_updated;
                    total.smtp_resealed += stats.smtp_resealed;
                    total.imap_resealed += stats.imap_resealed;
                }
                Err(error) => tracing::warn!(
                    org = %org_uuid,
                    error = %error,
                    "email account credential re-seal failed; retrying next run"
                ),
            }
        }
        Ok(total)
    }

    /// Re-seal up to `max_batches` of size `batch_size` for `email_accounts` in `org`.
    pub async fn reseal_email_accounts_in_org(
        &self,
        org: OrgId,
        cipher: Arc<dyn CredentialCipher>,
        batch_size: i64,
        max_batches: usize,
    ) -> Result<EmailResealStats, PgMailError> {
        let cipher = match cipher.scoped_for_org(*org.as_uuid()).await {
            Ok(Some(scoped)) => scoped,
            Ok(None) => cipher,
            Err(_) => return Err(cipher_err_to_mail()),
        };
        let Some(target_alg) = cipher.active_alg_id().map(str::to_owned) else {
            return Ok(EmailResealStats::default());
        };
        let Some(target_kek) = cipher.active_kek_id().map(str::to_owned) else {
            return Ok(EmailResealStats::default());
        };
        if batch_size <= 0 || max_batches == 0 {
            return Ok(EmailResealStats::default());
        }
        let mut total = EmailResealStats::default();
        for _ in 0..max_batches {
            let batch = self
                .reseal_email_accounts_batch(
                    org,
                    cipher.clone(),
                    &target_alg,
                    &target_kek,
                    batch_size,
                )
                .await?;
            total.accounts_updated += batch.accounts_updated;
            total.smtp_resealed += batch.smtp_resealed;
            total.imap_resealed += batch.imap_resealed;
            if batch.accounts_updated == 0 {
                break;
            }
        }
        Ok(total)
    }

    /// Execute at most one `FOR UPDATE SKIP LOCKED` re-seal batch on `email_accounts`.
    pub async fn reseal_email_accounts_batch(
        &self,
        org: OrgId,
        cipher: Arc<dyn CredentialCipher>,
        target_alg_id: &str,
        target_kek_id: &str,
        batch_size: i64,
    ) -> Result<EmailResealStats, PgMailError> {
        if batch_size <= 0 {
            return Ok(EmailResealStats::default());
        }
        let org_uuid = *org.as_uuid();
        let probe_alg = target_alg_id.to_owned();
        let probe_kek = target_kek_id.to_owned();
        let needs_reseal: bool = with_org_conn::<_, _, PgMailError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                Ok(sqlx::query_scalar(
                    "SELECT EXISTS ( \
                       SELECT 1 FROM email_accounts \
                        WHERE org_id = $1 \
                          AND (key_version <> 3 OR alg_id IS DISTINCT FROM $2 OR kek_id IS DISTINCT FROM $3 \
                               OR imap_key_version <> 3 OR imap_alg_id IS DISTINCT FROM $2 OR imap_kek_id IS DISTINCT FROM $3) \
                     )",
                )
                .bind(org_uuid)
                .bind(probe_alg)
                .bind(probe_kek)
                .fetch_one(tx.as_mut())
                .await?)
            })
        })
        .await?;
        if !needs_reseal {
            return Ok(EmailResealStats::default());
        }

        let target_alg = target_alg_id.to_owned();
        let target_kek = target_kek_id.to_owned();
        let org_str = org_uuid.to_string();
        with_audits::<_, _, PgMailError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let claimed = sqlx::query(
                    "SELECT id, smtp_password_ct, smtp_password_nonce, dek_wrapped, dek_nonce, \
                            key_version, alg_id, kek_id, smtp_msg_id, smtp_commitment_tag, \
                            imap_password_ct, imap_password_nonce, imap_dek_wrapped, imap_dek_nonce, \
                            imap_key_version, imap_alg_id, imap_kek_id, imap_msg_id, imap_commitment_tag \
                       FROM email_accounts \
                      WHERE org_id = $1 \
                        AND (key_version <> 3 OR alg_id IS DISTINCT FROM $2 OR kek_id IS DISTINCT FROM $3 \
                             OR imap_key_version <> 3 OR imap_alg_id IS DISTINCT FROM $2 OR imap_kek_id IS DISTINCT FROM $3) \
                      ORDER BY id LIMIT $4 FOR UPDATE SKIP LOCKED",
                )
                .bind(org_uuid)
                .bind(&target_alg)
                .bind(&target_kek)
                .bind(batch_size)
                .fetch_all(tx.as_mut())
                .await?;
                if claimed.is_empty() {
                    return Ok((EmailResealStats::default(), Vec::new()));
                }

                let mut stats = EmailResealStats::default();
                let mut events = Vec::with_capacity(claimed.len());
                for row in &claimed {
                    let account_id: Uuid = row.try_get("id")?;
                    let account_str = account_id.to_string();
                    let smtp = sealed_slot(row, false)?;
                    let imap = sealed_slot(row, true)?;
                    let smtp_needs = envelope_needs_reseal(&smtp, &target_alg, &target_kek);
                    let imap_needs = envelope_needs_reseal(&imap, &target_alg, &target_kek);
                    if !smtp_needs && !imap_needs {
                        continue;
                    }
                    if smtp_needs {
                        let aad = Aad {
                            org_id: &org_str,
                            account_id: &account_str,
                            field: "smtp_password",
                        };
                        let fresh = cipher.reseal(&smtp, aad).map_err(|_| cipher_err_to_mail())?;
                        update_slot_in_tx(tx, org_uuid, account_id, false, &fresh).await?;
                        stats.smtp_resealed += 1;
                    }
                    if imap_needs {
                        let aad = Aad {
                            org_id: &org_str,
                            account_id: &account_str,
                            field: "imap_password",
                        };
                        let fresh = cipher.reseal(&imap, aad).map_err(|_| cipher_err_to_mail())?;
                        update_slot_in_tx(tx, org_uuid, account_id, true, &fresh).await?;
                        stats.imap_resealed += 1;
                    }
                    stats.accounts_updated += 1;
                    events.push(
                        AuditEvent::new(
                            None,
                            AuditAction::new("email.account_credential_reseal")
                                .map_err(PgMailError::Domain)?,
                            "email_account",
                            account_str,
                            TraceContext::generate(),
                            Timestamp::now_utc(),
                        )
                        .with_source(AuditSource::Scheduler)
                        .with_org(org)
                        .with_snapshots(
                            None,
                            Some(json!({
                                "account_id": account_id,
                                "smtp_resealed": smtp_needs,
                                "imap_resealed": imap_needs,
                                "from_smtp_key_version": smtp_needs.then_some(smtp.key_version),
                                "from_smtp_kek_id": if smtp_needs { smtp.kek_id } else { None },
                                "from_imap_key_version": imap_needs.then_some(imap.key_version),
                                "from_imap_kek_id": if imap_needs { imap.kek_id } else { None },
                                "to_key_version": 3,
                                "to_alg_id": target_alg,
                                "to_kek_id": target_kek,
                            })),
                        ),
                    );
                }
                Ok((stats, events))
            })
        })
        .await
    }
}
