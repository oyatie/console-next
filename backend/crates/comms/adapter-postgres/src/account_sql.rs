// SPDX-License-Identifier: LicenseRef-Proprietary
//! SQL queries and row mappers for `email_accounts` sealed credential columns.

use console_comms_application::{AccountUpsert, EmailAccountId, SealedCredential, StoredAccount};
use console_comms_domain::MailSecurity;
use console_kernel_core::OrgId;
use sqlx::{Postgres, Row, Transaction};

use crate::PgMailError;

pub(crate) const ACCOUNT_SELECT_LATEST: &str = r#"
    SELECT id, org_id, display_name, email_address, from_name,
           imap_host, imap_port, imap_security, imap_username,
           smtp_host, smtp_port, smtp_security, smtp_username,
           smtp_password_ct, smtp_password_nonce, dek_wrapped, dek_nonce,
           imap_password_ct, imap_password_nonce, imap_dek_wrapped, imap_dek_nonce,
           key_version, imap_key_version,
           alg_id, kek_id, smtp_msg_id, smtp_commitment_tag,
           imap_alg_id, imap_kek_id, imap_msg_id, imap_commitment_tag,
           status
    FROM email_accounts
    ORDER BY created_at ASC
    LIMIT 1
"#;

pub(crate) const ACCOUNT_SELECT_BY_ID: &str = r#"
    SELECT id, org_id, display_name, email_address, from_name,
           imap_host, imap_port, imap_security, imap_username,
           smtp_host, smtp_port, smtp_security, smtp_username,
           smtp_password_ct, smtp_password_nonce, dek_wrapped, dek_nonce,
           imap_password_ct, imap_password_nonce, imap_dek_wrapped, imap_dek_nonce,
           key_version, imap_key_version,
           alg_id, kek_id, smtp_msg_id, smtp_commitment_tag,
           imap_alg_id, imap_kek_id, imap_msg_id, imap_commitment_tag,
           status
    FROM email_accounts
    WHERE id = $1
"#;

pub(crate) async fn insert_account_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_uuid: uuid::Uuid,
    upsert: &AccountUpsert,
    smtp: &SealedCredential,
    imap: &SealedCredential,
) -> Result<(), PgMailError> {
    sqlx::query(
        r#"
        INSERT INTO email_accounts (
            id, org_id, display_name, email_address, from_name,
            imap_host, imap_port, imap_security, imap_username,
            smtp_host, smtp_port, smtp_security, smtp_username,
            smtp_password_ct, smtp_password_nonce, dek_wrapped, dek_nonce,
            imap_password_ct, imap_password_nonce, imap_dek_wrapped, imap_dek_nonce,
            key_version, created_by, imap_key_version,
            alg_id, kek_id, smtp_msg_id, smtp_commitment_tag,
            imap_alg_id, imap_kek_id, imap_msg_id, imap_commitment_tag
        ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9,
            $10, $11, $12, $13,
            $14, $15, $16, $17,
            $18, $19, $20, $21,
            $22, $23, $24,
            $25, $26, $27, $28,
            $29, $30, $31, $32
        )
        "#,
    )
    .bind(*upsert.id.as_uuid())
    .bind(org_uuid)
    .bind(&upsert.display_name)
    .bind(&upsert.email_address)
    .bind(upsert.from_name.as_deref())
    .bind(&upsert.imap_host)
    .bind(i32::from(upsert.imap_port))
    .bind(upsert.imap_security.as_db_str())
    .bind(&upsert.imap_username)
    .bind(&upsert.smtp_host)
    .bind(i32::from(upsert.smtp_port))
    .bind(upsert.smtp_security.as_db_str())
    .bind(&upsert.smtp_username)
    .bind(&smtp.ciphertext)
    .bind(&smtp.nonce)
    .bind(&smtp.dek_wrapped)
    .bind(&smtp.dek_nonce)
    .bind(&imap.ciphertext)
    .bind(&imap.nonce)
    .bind(&imap.dek_wrapped)
    .bind(&imap.dek_nonce)
    .bind(smtp.key_version)
    .bind(*upsert.actor.as_uuid())
    .bind(imap.key_version)
    .bind(smtp.alg_id.as_deref())
    .bind(smtp.kek_id.as_deref())
    .bind(smtp.msg_id.as_deref())
    .bind(smtp.commitment_tag.as_deref())
    .bind(imap.alg_id.as_deref())
    .bind(imap.kek_id.as_deref())
    .bind(imap.msg_id.as_deref())
    .bind(imap.commitment_tag.as_deref())
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

pub(crate) async fn update_account_tx(
    tx: &mut Transaction<'_, Postgres>,
    upsert: &AccountUpsert,
) -> Result<(), PgMailError> {
    sqlx::query(
        r#"
        UPDATE email_accounts
        SET display_name = $2, email_address = $3, from_name = $4,
            imap_host = $5, imap_port = $6, imap_security = $7, imap_username = $8,
            smtp_host = $9, smtp_port = $10, smtp_security = $11, smtp_username = $12,
            updated_at = now()
        WHERE id = $1
        "#,
    )
    .bind(*upsert.id.as_uuid())
    .bind(&upsert.display_name)
    .bind(&upsert.email_address)
    .bind(upsert.from_name.as_deref())
    .bind(&upsert.imap_host)
    .bind(i32::from(upsert.imap_port))
    .bind(upsert.imap_security.as_db_str())
    .bind(&upsert.imap_username)
    .bind(&upsert.smtp_host)
    .bind(i32::from(upsert.smtp_port))
    .bind(upsert.smtp_security.as_db_str())
    .bind(&upsert.smtp_username)
    .execute(tx.as_mut())
    .await?;

    if let Some(smtp) = &upsert.smtp_password {
        sqlx::query(
            r#"
            UPDATE email_accounts
            SET smtp_password_ct = $2, smtp_password_nonce = $3,
                dek_wrapped = $4, dek_nonce = $5, key_version = $6,
                alg_id = $7, kek_id = $8, smtp_msg_id = $9, smtp_commitment_tag = $10,
                updated_at = now()
            WHERE id = $1
            "#,
        )
        .bind(*upsert.id.as_uuid())
        .bind(&smtp.ciphertext)
        .bind(&smtp.nonce)
        .bind(&smtp.dek_wrapped)
        .bind(&smtp.dek_nonce)
        .bind(smtp.key_version)
        .bind(smtp.alg_id.as_deref())
        .bind(smtp.kek_id.as_deref())
        .bind(smtp.msg_id.as_deref())
        .bind(smtp.commitment_tag.as_deref())
        .execute(tx.as_mut())
        .await?;
    }
    if let Some(imap) = &upsert.imap_password {
        sqlx::query(
            r#"
            UPDATE email_accounts
            SET imap_password_ct = $2, imap_password_nonce = $3,
                imap_dek_wrapped = $4, imap_dek_nonce = $5, imap_key_version = $6,
                imap_alg_id = $7, imap_kek_id = $8, imap_msg_id = $9, imap_commitment_tag = $10,
                updated_at = now()
            WHERE id = $1
            "#,
        )
        .bind(*upsert.id.as_uuid())
        .bind(&imap.ciphertext)
        .bind(&imap.nonce)
        .bind(&imap.dek_wrapped)
        .bind(&imap.dek_nonce)
        .bind(imap.key_version)
        .bind(imap.alg_id.as_deref())
        .bind(imap.kek_id.as_deref())
        .bind(imap.msg_id.as_deref())
        .bind(imap.commitment_tag.as_deref())
        .execute(tx.as_mut())
        .await?;
    }
    Ok(())
}

pub(crate) async fn fetch_account_tx(
    tx: &mut Transaction<'_, Postgres>,
    account_uuid: uuid::Uuid,
) -> Result<StoredAccount, PgMailError> {
    let row = sqlx::query(ACCOUNT_SELECT_BY_ID)
        .bind(account_uuid)
        .fetch_one(tx.as_mut())
        .await?;
    account_from_row(row)
}

pub(crate) fn account_from_row(row: sqlx::postgres::PgRow) -> Result<StoredAccount, PgMailError> {
    let imap_security = MailSecurity::parse(row.try_get::<String, _>("imap_security")?.as_str())?;
    let smtp_security = MailSecurity::parse(row.try_get::<String, _>("smtp_security")?.as_str())?;

    let smtp_password = SealedCredential {
        ciphertext: row.try_get("smtp_password_ct")?,
        nonce: row.try_get("smtp_password_nonce")?,
        dek_wrapped: row.try_get("dek_wrapped")?,
        dek_nonce: row.try_get("dek_nonce")?,
        key_version: row.try_get("key_version")?,
        alg_id: row.try_get("alg_id")?,
        kek_id: row.try_get("kek_id")?,
        msg_id: row.try_get("smtp_msg_id")?,
        commitment_tag: row.try_get("smtp_commitment_tag")?,
    };
    let imap_password = SealedCredential {
        ciphertext: row.try_get("imap_password_ct")?,
        nonce: row.try_get("imap_password_nonce")?,
        dek_wrapped: row.try_get("imap_dek_wrapped")?,
        dek_nonce: row.try_get("imap_dek_nonce")?,
        key_version: row.try_get("imap_key_version")?,
        alg_id: row.try_get("imap_alg_id")?,
        kek_id: row.try_get("imap_kek_id")?,
        msg_id: row.try_get("imap_msg_id")?,
        commitment_tag: row.try_get("imap_commitment_tag")?,
    };

    Ok(StoredAccount {
        id: EmailAccountId::from_uuid(row.try_get("id")?),
        org_id: OrgId::from_uuid(row.try_get("org_id")?),
        display_name: row.try_get("display_name")?,
        email_address: row.try_get("email_address")?,
        from_name: row.try_get("from_name")?,
        imap_host: row.try_get("imap_host")?,
        imap_port: u16::try_from(row.try_get::<i32, _>("imap_port")?).unwrap_or(993),
        imap_security,
        imap_username: row.try_get("imap_username")?,
        smtp_host: row.try_get("smtp_host")?,
        smtp_port: u16::try_from(row.try_get::<i32, _>("smtp_port")?).unwrap_or(587),
        smtp_security,
        smtp_username: row.try_get("smtp_username")?,
        smtp_password,
        imap_password,
        status: row.try_get("status")?,
    })
}
