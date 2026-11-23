// SPDX-License-Identifier: LicenseRef-Proprietary
//! Realtime webmail notification adapter over PostgreSQL `pg_notify`.

use console_comms_application::{EmailAccountId, MailFuture, MailNotifier};
use sqlx::PgPool;

/// The LISTEN/NOTIFY channel a webmail message-posted signal rides on. Mirrors
/// the messenger realtime channel: the payload carries only the account id (no
/// message content), and a background listener fans it out to the tenant's UI.
pub const MAIL_POSTED_CHANNEL: &str = "mail_posted";

/// A realtime [`MailNotifier`] over PostgreSQL `pg_notify`. Emitted when the mox
/// delivery webhook ingests a NEW inbound message so the tenant's mailbox UI can
/// refresh. Best-effort: a notify failure never fails the enclosing ingest.
#[derive(Debug, Clone)]
pub struct PgMailNotifier {
    pool: PgPool,
}

impl PgMailNotifier {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

impl MailNotifier for PgMailNotifier {
    fn notify_posted(&self, account_id: EmailAccountId) -> MailFuture<'_, ()> {
        Box::pin(async move {
            // pg_notify carries only the account id — no tenant-table row is read
            // or written, so no org arming is needed here.
            if let Err(err) = sqlx::query("SELECT pg_notify($1, $2)")
                .bind(MAIL_POSTED_CHANNEL)
                .bind(account_id.to_string())
                // rls-arming: ok pg_notify carries an id only; it is not a tenant-table read/write
                .execute(&self.pool)
                .await
            {
                tracing::warn!(error = %err, "mail posted notify failed (best-effort)");
            }
        })
    }
}
