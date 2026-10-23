//! The messenger and notification row reads the hub re-runs.

use console_kernel_core::{BranchId, BranchScope, MessageId, NotificationId, ThreadId, UserId};
use console_messenger_application::MessageSummary;
use console_notifications_application::NotificationSummary;
use console_notifications_domain::NotificationLink;
use sqlx::{Postgres, QueryBuilder, Row};

pub(crate) fn message_select_builder() -> QueryBuilder<Postgres> {
    QueryBuilder::<Postgres>::new(
        r#"
        SELECT m.id, m.thread_id, m.branch_id, m.sender_id, m.body,
               m.quoted_message_id,
               quoted.body AS quoted_body,
               quoted_sender.display_name AS quoted_sender_name,
               m.sent_at, m.created_at, sender.display_name AS sender_name,
               COALESCE(att.attachment_evidence_ids, ARRAY[]::uuid[]) AS attachment_evidence_ids,
               COUNT(DISTINCT tm_read_target.user_id)::BIGINT AS read_target_count,
               COUNT(DISTINCT tm_read_target.user_id) FILTER (
                   WHERE read_receipt_message.id IS NOT NULL
                     AND (read_receipt_message.sent_at, read_receipt_message.id) >= (m.sent_at, m.id)
               )::BIGINT AS read_count,
               (SELECT COUNT(*) FROM messenger_message_acks ack
                WHERE ack.message_id = m.id)::BIGINT AS ack_count
        FROM messenger_messages m
        LEFT JOIN LATERAL (
            SELECT array_agg(a.evidence_id ORDER BY a.sort_order) AS attachment_evidence_ids
            FROM messenger_message_attachments a
            WHERE a.message_id = m.id
        ) att ON true
        LEFT JOIN messenger_thread_members tm_read_target
          ON tm_read_target.thread_id = m.thread_id
         AND tm_read_target.user_id <> m.sender_id
        LEFT JOIN messenger_read_receipts read_receipt
          ON read_receipt.thread_id = m.thread_id
         AND read_receipt.user_id = tm_read_target.user_id
        LEFT JOIN messenger_messages read_receipt_message
          ON read_receipt_message.id = read_receipt.last_read_message_id
        LEFT JOIN messenger_messages quoted ON quoted.id = m.quoted_message_id
        LEFT JOIN person_accounts_current quoted_sender ON quoted_sender.id = quoted.sender_id
        -- Same-org JOIN: `users` is RLS-scoped to app.current_org like the
        -- messages, so a sender only resolves within the caller's tenant.
        LEFT JOIN person_accounts_current sender ON sender.id = m.sender_id
        "#,
    )
}

pub(crate) const REALTIME_MESSAGE_GROUP_BY: &str = " GROUP BY m.id, sender.display_name, quoted.body, quoted_sender.display_name, att.attachment_evidence_ids";

pub(crate) fn message_summary_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<MessageSummary, sqlx::Error> {
    let attachment_ids: Vec<uuid::Uuid> = row.try_get("attachment_evidence_ids")?;
    Ok(MessageSummary {
        id: MessageId::from_uuid(row.try_get("id")?),
        thread_id: ThreadId::from_uuid(row.try_get("thread_id")?),
        branch_id: BranchId::from_uuid(row.try_get("branch_id")?),
        sender_id: UserId::from_uuid(row.try_get("sender_id")?),
        sender_name: row.try_get("sender_name")?,
        body: row.try_get("body")?,
        read_count: row.try_get("read_count")?,
        read_target_count: row.try_get("read_target_count")?,
        ack_count: row.try_get("ack_count")?,
        // A realtime read has no single "me": the acting user learns their own
        // ack state from the toggle response, so this per-viewer flag is false
        // on the wire (and a freshly-posted message has no acks anyway).
        acked_by_me: false,
        quoted_message_id: row
            .try_get::<Option<uuid::Uuid>, _>("quoted_message_id")?
            .map(MessageId::from_uuid),
        quoted_body: row.try_get("quoted_body")?,
        quoted_sender_name: row.try_get("quoted_sender_name")?,
        attachment_evidence_ids: attachment_ids
            .into_iter()
            .map(console_kernel_core::EvidenceId::from_uuid)
            .collect(),
        sent_at: row.try_get("sent_at")?,
        created_at: row.try_get("created_at")?,
    })
}

pub(crate) fn notification_summary_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<NotificationSummary, sqlx::Error> {
    let link_json: serde_json::Value = row.try_get("link")?;
    let link: NotificationLink =
        serde_json::from_value(link_json).map_err(|err| sqlx::Error::Decode(Box::new(err)))?;
    Ok(NotificationSummary {
        id: NotificationId::from_uuid(row.try_get("id")?),
        recipient_user_id: UserId::from_uuid(row.try_get("recipient_user_id")?),
        category: row.try_get("category")?,
        kind: row.try_get("kind")?,
        text: row.try_get("body")?,
        link,
        unread: row.try_get("unread")?,
        created_at: row.try_get("created_at")?,
        read_at: row.try_get("read_at")?,
        resolved_at: row.try_get("resolved_at")?,
        // Emit-time routing already skipped the notifier for mute-suppressed
        // rows, so a notification that reaches realtime fan-out was unmuted at
        // emit time — false on the wire, like `acked_by_me` above.
        muted: false,
    })
}

pub(crate) fn push_scope_filter(
    builder: &mut QueryBuilder<Postgres>,
    column: &str,
    scope: &BranchScope,
) {
    match scope {
        BranchScope::All => {}
        BranchScope::Branches(branches) if branches.is_empty() => {
            builder.push(" AND false");
        }
        BranchScope::Branches(branches) => {
            let branch_ids: Vec<uuid::Uuid> =
                branches.iter().map(|branch| *branch.as_uuid()).collect();
            builder.push(" AND ");
            builder.push(column);
            builder.push(" = ANY(");
            builder.push_bind(branch_ids);
            builder.push(")");
        }
    }
}
