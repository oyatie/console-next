// SPDX-License-Identifier: LicenseRef-Proprietary
use std::sync::Arc;

use console_comms_application::{InboundUpsert, MailAttachmentStore, inbound_sync_audit_event};
use console_kernel_core::{OrgId, Timestamp, TraceContext};
use console_platform_db::{with_audit, with_org_conn};
use sqlx::{Postgres, Transaction};

use crate::{
    PgMailError, PgMailStore, advance_folder_cursor_tx, insert_attachment_tx,
    insert_inbound_message_tx, message_id_seen, resolve_inbound_thread_tx,
    update_thread_aggregate_tx,
};

impl PgMailStore {
    pub(super) async fn upsert_inbound_inner(
        &self,
        org: OrgId,
        upsert: InboundUpsert,
        imap_sync: bool,
    ) -> Result<(bool, Option<uuid::Uuid>), PgMailError> {
        // Build the audit BEFORE the transaction so `with_audit` arms the org.
        let audit =
            inbound_sync_audit_event(upsert.id, TraceContext::generate(), Timestamp::now_utc())
                .map_err(PgMailError::Domain)?
                .with_org(org);

        with_audit::<_, _, PgMailError>(&self.pool, audit, move |tx| {
            Box::pin(async move {
                let (inserted, pending) = stage_receipt_tx(tx, org, &upsert, imap_sync).await?;
                if pending.is_none() {
                    // Webhooks use a synthetic UID under validity zero.
                    let validity =
                        (imap_sync || upsert.uid_validity != 0).then_some(upsert.uid_validity);
                    advance_folder_cursor_tx(
                        tx,
                        upsert.folder_id,
                        validity,
                        upsert.message.imap_uid,
                    )
                    .await?;
                }
                Ok((inserted, pending))
            })
        })
        .await
    }

    pub(super) async fn sync_inbound_inner(
        &self,
        org: OrgId,
        mut upsert: InboundUpsert,
        storage: Arc<dyn MailAttachmentStore>,
    ) -> Result<bool, PgMailError> {
        let folder_id = upsert.folder_id;
        let validity = upsert.uid_validity;
        let uid = upsert.message.imap_uid;
        let parts = std::mem::take(&mut upsert.message.attachments);
        let (inserted, pending) = self.upsert_inbound_inner(org, upsert, true).await?;
        let Some(message_id) = pending else {
            return Ok(inserted);
        };

        for (index, part) in parts.into_iter().enumerate() {
            let ordinal = i16::try_from(index + 1).map_err(|_| PgMailError::OperationConflict)?;
            let storage = storage.clone();
            with_org_conn::<_, (), PgMailError>(&self.pool, org, move |tx| {
                Box::pin(async move {
                    // The original key is already committed and visible to tenant erasure.
                    // Hold the row lock until PUT completes so retries and row deletion wait.
                    let row: Option<(String, String)> = sqlx::query_as(
                        "SELECT s3_key, content_type FROM email_attachments
                         WHERE message_id = $1 AND sort_order = $2 AND upload_state = 'PENDING' FOR UPDATE",
                    )
                    .bind(message_id)
                    .bind(ordinal)
                    .fetch_optional(tx.as_mut())
                    .await?;
                    if let Some((key, content_type)) = row {
                        storage.put(key, content_type, part.bytes)
                            .await
                            .map_err(PgMailError::AttachmentUpload)?;
                        sqlx::query("UPDATE email_attachments SET upload_state = 'CONFIRMED'
                                     WHERE message_id = $1 AND sort_order = $2")
                            .bind(message_id)
                            .bind(ordinal)
                            .execute(tx.as_mut())
                            .await?;
                    }
                    Ok(())
                })
            })
            .await?;
        }

        with_org_conn::<_, (), PgMailError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let complete: bool = sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM email_messages WHERE id = $1)
                    AND NOT EXISTS (SELECT 1 FROM email_attachments
                                    WHERE message_id = $1 AND upload_state = 'PENDING')",
                )
                .bind(message_id)
                .fetch_one(tx.as_mut())
                .await?;
                if !complete {
                    return Err(PgMailError::OperationConflict);
                }
                advance_folder_cursor_tx(tx, folder_id, Some(validity), uid).await
            })
        })
        .await?;
        Ok(inserted)
    }
}

/// Returns whether the message was inserted and which canonical message still has uploads.
async fn stage_receipt_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    upsert: &InboundUpsert,
    imap_sync: bool,
) -> Result<(bool, Option<uuid::Uuid>), PgMailError> {
    let org_uuid = *org.as_uuid();
    let account_uuid = *upsert.account_id.as_uuid();
    // Serialize webhook and IMAP receipts for the same logical mailbox.
    sqlx::query("SELECT id FROM email_accounts WHERE id = $1 FOR NO KEY UPDATE")
        .bind(account_uuid)
        .fetch_one(tx.as_mut())
        .await?;

    // 1. Idempotency gate on the IMAP identity: if a row already
    // exists for (account, folder, uid_validity, uid), this is a
    // re-sync — refresh its mutable flags and return `false` (no dup).
    let existing: Option<uuid::Uuid> = sqlx::query_scalar(
        r#"
        SELECT id FROM email_messages
        WHERE account_id = $1 AND folder_id = $2
          AND imap_uid_validity = $3 AND imap_uid = $4
        LIMIT 1
        "#,
    )
    .bind(account_uuid)
    .bind(upsert.folder_id)
    .bind(upsert.uid_validity)
    .bind(i64::from(upsert.message.imap_uid))
    .fetch_optional(tx.as_mut())
    .await?;

    if let Some(existing_id) = existing {
        sqlx::query(
            r#"
            UPDATE email_messages
            SET seen = $2, flagged = $3, answered = $4, draft = $5, updated_at = now()
            WHERE id = $1
            "#,
        )
        .bind(existing_id)
        .bind(upsert.message.seen)
        .bind(upsert.message.flagged)
        .bind(upsert.message.answered)
        .bind(upsert.message.draft)
        .execute(tx.as_mut())
        .await?;
        let pending: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM email_attachments WHERE message_id = $1 AND upload_state = 'PENDING')",
        )
        .bind(existing_id)
        .fetch_one(tx.as_mut())
        .await?;
        return Ok((false, pending.then_some(existing_id)));
    }

    // 2. Secondary dedupe on Message-ID within the account: a message
    // already mirrored under another folder (e.g. a Sent copy) is not
    // re-inserted; we still return `false`.
    if let Some(ref mid) = upsert.message.message_id
        && message_id_seen(tx, account_uuid, mid).await?
    {
        return Ok((false, None));
    }

    // 3. Resolve the thread by the References/subject grouping key.
    let thread_id = resolve_inbound_thread_tx(tx, org_uuid, account_uuid, upsert).await?;

    // 4. Insert the IN message. If a concurrent webhook redelivery won
    // the same IMAP-identity race, the insert is an idempotent no-op
    // and the handler reports `ingested=false` instead of surfacing
    // a unique-constraint service error.
    if !insert_inbound_message_tx(tx, org_uuid, account_uuid, thread_id, upsert).await? {
        return Ok((false, None));
    }

    // 5. Insert its attachment rows.
    let state = if imap_sync { "PENDING" } else { "CONFIRMED" };
    for att in &upsert.stored_attachments {
        insert_attachment_tx(tx, org_uuid, *upsert.id.as_uuid(), att, state).await?;
    }

    // 6. Maintain the thread aggregate + the folder high-water mark.
    update_thread_aggregate_tx(tx, thread_id, upsert).await?;
    if imap_sync && !upsert.stored_attachments.is_empty() {
        return Ok((true, Some(*upsert.id.as_uuid())));
    }

    Ok((true, None))
}
