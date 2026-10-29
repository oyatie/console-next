// SPDX-License-Identifier: LicenseRef-Proprietary
//! Transaction-aware delivery for composite, audited commands.
use super::*;
use console_kernel_core::{AuditEvent, UserId};
use sqlx::Transaction;

/// Insert a document and return its audits for the caller's `with_audits` batch.
/// The caller must arm tenant RLS and commit the returned audits atomically.
/// Deduplicated deliveries return the existing document without another audit.
pub async fn emit_inbox_doc_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    command: EmitInboxDocCommand,
) -> Result<(InboxDocSummary, Vec<AuditEvent>), PgInboxError> {
    emit_with_id_in_tx(tx, org, InboxDocId::new(), command).await
}

pub(super) async fn emit(
    store: &PgInboxStore,
    command: EmitInboxDocCommand,
) -> Result<InboxDocSummary, PgInboxError> {
    let org = current_org().map_err(KernelError::from)?;
    let recipient = command.recipient;
    let key = command.dedup_key.clone();
    if key.is_some() {
        let lookup = key.clone();
        if let Some(existing) = with_org_conn(&store.pool, org, move |tx| {
            Box::pin(async move { find_by_dedup_in_tx(tx, recipient, lookup.as_deref()).await })
        })
        .await?
        {
            return Ok(existing);
        }
    }
    let id = InboxDocId::new();
    let event = emit_event(org, id, &command)?;
    let inserted = with_audit(&store.pool, event, move |tx| {
        Box::pin(async move {
            let (summary, events) = emit_with_id_in_tx(tx, org, id, command).await?;
            if events.is_empty() {
                return Err(PgInboxError::Dedup);
            }
            Ok(summary)
        })
    })
    .await;
    match inserted {
        Err(PgInboxError::Dedup) => {
            with_org_conn(&store.pool, org, move |tx| {
                Box::pin(async move {
                    find_by_dedup_in_tx(tx, recipient, key.as_deref())
                        .await?
                        .ok_or_else(|| {
                            KernelError::internal("dedup conflict but no existing inbox document")
                                .into()
                        })
                })
            })
            .await
        }
        result => result,
    }
}

async fn emit_with_id_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    id: InboxDocId,
    command: EmitInboxDocCommand,
) -> Result<(InboxDocSummary, Vec<AuditEvent>), PgInboxError> {
    if let Some(key) = command.dedup_key.as_deref()
        && let Some(existing) = find_by_dedup_in_tx(tx, command.recipient, Some(key)).await?
    {
        return Ok((existing, Vec::new()));
    }
    let event = emit_event(org, id, &command)?;
    let row = sqlx::query(
        "INSERT INTO inbox_docs (
            id, org_id, recipient_user_id, kind, notice_type, title,
            payload, legal_basis, source_kind, source_id, dedup_key
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (org_id, recipient_user_id, dedup_key)
             WHERE dedup_key IS NOT NULL DO NOTHING
         RETURNING id, recipient_user_id, kind, notice_type, title, legal_basis,
                   source_kind, source_id, confirmed_by, confirmed_at, created_at",
    )
    .bind(id.as_uuid())
    .bind(org.as_uuid())
    .bind(command.recipient.as_uuid())
    .bind(command.doc.kind.as_str())
    .bind(command.doc.notice_type)
    .bind(command.doc.title)
    .bind(command.doc.payload)
    .bind(command.doc.legal_basis)
    .bind(command.doc.source_kind)
    .bind(command.doc.source_id)
    .bind(&command.dedup_key)
    .fetch_optional(tx.as_mut())
    .await?;
    if let Some(row) = row {
        return Ok((summary_from_row(&row)?, vec![event]));
    }
    let existing = find_by_dedup_in_tx(tx, command.recipient, command.dedup_key.as_deref())
        .await?
        .ok_or_else(|| KernelError::internal("dedup conflict but no existing inbox document"))?;
    Ok((existing, Vec::new()))
}

async fn find_by_dedup_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    recipient: UserId,
    key: Option<&str>,
) -> Result<Option<InboxDocSummary>, PgInboxError> {
    let row = sqlx::query(
        "SELECT id, recipient_user_id, kind, notice_type, title, legal_basis,
                source_kind, source_id, confirmed_by, confirmed_at, created_at
         FROM inbox_docs WHERE recipient_user_id=$1 AND dedup_key=$2",
    )
    .bind(recipient.as_uuid())
    .bind(key)
    .fetch_optional(tx.as_mut())
    .await?;
    row.as_ref().map(summary_from_row).transpose()
}

fn emit_event(
    org: OrgId,
    id: InboxDocId,
    command: &EmitInboxDocCommand,
) -> Result<AuditEvent, PgInboxError> {
    Ok(inbox_doc_audit_event(
        "inbox_doc.emit",
        command.actor,
        id,
        command.trace.clone(),
        command.occurred_at,
    )?
    .with_org(org)
    .with_snapshots(
        None,
        Some(serde_json::json!({
            "kind": command.doc.kind.as_str(),
            "notice_type": command.doc.notice_type,
            "recipient_user_id": command.recipient.as_uuid(),
        })),
    ))
}
