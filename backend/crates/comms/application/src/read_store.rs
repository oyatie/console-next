use crate::{
    AddressLookup, AttachmentRef, DueAccount, EmailAccountId, EmailMessageId, FolderCursor,
    FolderView, ImapFolder, InboundUpsert, MailAttachmentStore, MailFuture, MailServiceError,
    MessageView, ThreadDetail, ThreadQuery, ThreadView,
};
use console_kernel_core::{AuditEvent, OrgId, Timestamp};

// ---------------------------------------------------------------------------
// Inbound store port (extends MailStore conceptually; kept a separate trait so
// the send-only B-mail-2 surface is unchanged and the read API is cohesive).
// ---------------------------------------------------------------------------

/// Persistence port for the inbound sync engine + the read API. Every method is
/// org-scoped in the adapter (`with_org_conn`/`with_audit` armed to the org). The
/// sync methods are driven by the background worker; the read methods back the
/// REST GET endpoints.
pub trait MailReadStore: Send + Sync {
    /// Ensure the folder rows exist for `account` (upsert on `(org, account,
    /// imap_path)`) and return them as cursors. Arms the account's org.
    fn upsert_folders<'a>(
        &'a self,
        org: OrgId,
        account: EmailAccountId,
        folders: &'a [ImapFolder],
    ) -> MailFuture<'a, Result<Vec<FolderCursor>, MailServiceError>>;

    /// Reset a folder's cursor to 0 and stamp the new UIDVALIDITY (called when the
    /// server's UIDVALIDITY no longer matches the persisted one — the stored UIDs
    /// are stale). Arms the account's org.
    fn reset_folder_cursor<'a>(
        &'a self,
        org: OrgId,
        folder_id: uuid::Uuid,
        uid_validity: i64,
    ) -> MailFuture<'a, Result<(), MailServiceError>>;

    /// Idempotently UPSERT one inbound message into its thread/folder under the
    /// armed org, returning whether a NEW row was inserted (`true`) or an existing
    /// row was refreshed (`false`, a re-sync of the same UID). Maintains the
    /// thread aggregate (last_message_at / counts / has_attachments) and the
    /// folder's `last_seen_uid` high-water mark.
    fn upsert_inbound<'a>(
        &'a self,
        org: OrgId,
        upsert: InboundUpsert,
    ) -> MailFuture<'a, Result<bool, MailServiceError>>;

    /// Reserve attachment keys before writing objects. Retries reuse the keys
    /// belonging to the original IMAP message and only upload unfinished parts.
    fn sync_inbound<'a>(
        &'a self,
        org: OrgId,
        upsert: InboundUpsert,
        storage: std::sync::Arc<dyn MailAttachmentStore>,
    ) -> MailFuture<'a, Result<bool, MailServiceError>>;

    /// Stamp the account's sync lifecycle (last_sync_at / sync_status / error)
    /// AND release the scheduler's claim lease — but only if `claim_token` still
    /// matches the row's live token (a fenced compare-and-clear). A worker whose
    /// lease was already reclaimed by another worker (a newer token) clears
    /// nothing, so it cannot wipe the reclaimer's fresh lease. Arms the account's
    /// org.
    fn record_sync_result<'a>(
        &'a self,
        org: OrgId,
        account: EmailAccountId,
        claim_token: uuid::Uuid,
        status: &'a str,
        error: Option<&'a str>,
    ) -> MailFuture<'a, Result<(), MailServiceError>>;

    /// Release the scheduler's claim lease WITHOUT touching the sync lifecycle —
    /// no `last_sync_at`/`sync_status`/`last_sync_error`/auth-failure-count
    /// write. Used by the early-exit paths (the account vanished, was paused, or
    /// changed identity since enumeration) where no sync attempt was actually
    /// made, so nothing should be recorded as a completed pass. Fenced by
    /// `claim_token` exactly like `record_sync_result`: only the worker still
    /// holding the matching token clears the lease. Arms the account's org.
    fn release_claim<'a>(
        &'a self,
        org: OrgId,
        account: EmailAccountId,
        claim_token: uuid::Uuid,
    ) -> MailFuture<'a, Result<(), MailServiceError>>;

    /// Owner-conn enumeration of accounts DUE for a sync pass (last_sync_at older
    /// than the cadence, status ACTIVE). Reads ONLY (org_id, account_id) and is
    /// NOT armed to any single org — it is the scheduler tick that drives the
    /// per-tenant arming, so it must see across tenants. The adapter runs it on a
    /// dedicated owner connection that bypasses RLS for this id-only read.
    /// `limit` MUST be the number of sync passes the caller can start
    /// immediately (e.g. the concurrency permits already acquired) — claiming
    /// more than that stamps a 600s lease on accounts that then sit queued
    /// before their pass even begins, eating into the lease before the sync
    /// timeout clock (which only starts once the pass runs) has a chance to
    /// bound it.
    fn list_due_accounts(
        &self,
        now: Timestamp,
        limit: i32,
    ) -> MailFuture<'_, Result<Vec<DueAccount>, MailServiceError>>;

    /// Resolve the account whose `email_address` matches `address`. Like
    /// [`list_due_accounts`] this is an id-only lookup on an owner connection
    /// that must see ACROSS tenants — the mox delivery webhook has no request
    /// principal, so the recipient address is the only tenant selector. A
    /// [`AddressLookup::Found`] result arms the resolved org for the actual
    /// ingest; [`AddressLookup::Ambiguous`] (the address exists under more than
    /// one org) MUST deliver to none of them. Reads NO message content.
    fn find_account_by_address<'a>(
        &'a self,
        address: &'a str,
    ) -> MailFuture<'a, Result<AddressLookup, MailServiceError>>;

    // --- READ API (backs the REST GET endpoints; all org-armed) -------------

    /// List the account's folders (for the folder rail).
    fn list_folders<'a>(
        &'a self,
        org: OrgId,
        account: EmailAccountId,
    ) -> MailFuture<'a, Result<Vec<FolderView>, MailServiceError>>;

    /// Page the account's threads (newest first), optionally filtered to unread
    /// and/or a full-text `q`. `before` is the keyset cursor (last seen
    /// `last_message_at`); `limit` is capped by the adapter.
    fn list_threads<'a>(
        &'a self,
        org: OrgId,
        account: EmailAccountId,
        query: &'a ThreadQuery,
    ) -> MailFuture<'a, Result<Vec<ThreadView>, MailServiceError>>;

    /// Fetch one thread's messages (oldest first), or `None` if the thread is not
    /// visible under the armed org.
    fn get_thread<'a>(
        &'a self,
        org: OrgId,
        thread_id: uuid::Uuid,
    ) -> MailFuture<'a, Result<Option<ThreadDetail>, MailServiceError>>;

    /// Fetch one message (with its attachments), or `None`.
    fn get_message<'a>(
        &'a self,
        org: OrgId,
        message_id: EmailMessageId,
    ) -> MailFuture<'a, Result<Option<MessageView>, MailServiceError>>;

    /// Resolve a stored attachment's (s3_key, filename, content_type) within the
    /// armed org, or `None` if it is not visible. Used to issue a presigned GET.
    fn get_attachment_key<'a>(
        &'a self,
        org: OrgId,
        attachment_id: uuid::Uuid,
    ) -> MailFuture<'a, Result<Option<AttachmentRef>, MailServiceError>>;

    /// Set every inbound message in a visible thread to read/unread and
    /// recompute thread/folder unread aggregates. Returns `false` when the
    /// thread is not visible under the armed org.
    fn set_thread_seen<'a>(
        &'a self,
        org: OrgId,
        thread_id: uuid::Uuid,
        seen: bool,
        audit: AuditEvent,
    ) -> MailFuture<'a, Result<bool, MailServiceError>>;
}

/// Forward the read store through a shared reference, so a `&R` satisfies a
/// generic `R: MailReadStore` bound (mirrors the `&C: CredentialCipher` blanket
/// impl). Lets a caller pass `&store` without moving it (the worker passes owned
/// values; tests and the REST layer pass references).
impl<R: MailReadStore + ?Sized> MailReadStore for &R {
    fn upsert_folders<'a>(
        &'a self,
        org: OrgId,
        account: EmailAccountId,
        folders: &'a [ImapFolder],
    ) -> MailFuture<'a, Result<Vec<FolderCursor>, MailServiceError>> {
        (**self).upsert_folders(org, account, folders)
    }

    fn reset_folder_cursor<'a>(
        &'a self,
        org: OrgId,
        folder_id: uuid::Uuid,
        uid_validity: i64,
    ) -> MailFuture<'a, Result<(), MailServiceError>> {
        (**self).reset_folder_cursor(org, folder_id, uid_validity)
    }

    fn upsert_inbound<'a>(
        &'a self,
        org: OrgId,
        upsert: InboundUpsert,
    ) -> MailFuture<'a, Result<bool, MailServiceError>> {
        (**self).upsert_inbound(org, upsert)
    }

    fn sync_inbound<'a>(
        &'a self,
        org: OrgId,
        upsert: InboundUpsert,
        storage: std::sync::Arc<dyn MailAttachmentStore>,
    ) -> MailFuture<'a, Result<bool, MailServiceError>> {
        (**self).sync_inbound(org, upsert, storage)
    }

    fn record_sync_result<'a>(
        &'a self,
        org: OrgId,
        account: EmailAccountId,
        claim_token: uuid::Uuid,
        status: &'a str,
        error: Option<&'a str>,
    ) -> MailFuture<'a, Result<(), MailServiceError>> {
        (**self).record_sync_result(org, account, claim_token, status, error)
    }

    fn release_claim<'a>(
        &'a self,
        org: OrgId,
        account: EmailAccountId,
        claim_token: uuid::Uuid,
    ) -> MailFuture<'a, Result<(), MailServiceError>> {
        (**self).release_claim(org, account, claim_token)
    }

    fn list_due_accounts(
        &self,
        now: Timestamp,
        limit: i32,
    ) -> MailFuture<'_, Result<Vec<DueAccount>, MailServiceError>> {
        (**self).list_due_accounts(now, limit)
    }

    fn find_account_by_address<'a>(
        &'a self,
        address: &'a str,
    ) -> MailFuture<'a, Result<AddressLookup, MailServiceError>> {
        (**self).find_account_by_address(address)
    }

    fn list_folders<'a>(
        &'a self,
        org: OrgId,
        account: EmailAccountId,
    ) -> MailFuture<'a, Result<Vec<FolderView>, MailServiceError>> {
        (**self).list_folders(org, account)
    }

    fn list_threads<'a>(
        &'a self,
        org: OrgId,
        account: EmailAccountId,
        query: &'a ThreadQuery,
    ) -> MailFuture<'a, Result<Vec<ThreadView>, MailServiceError>> {
        (**self).list_threads(org, account, query)
    }

    fn get_thread<'a>(
        &'a self,
        org: OrgId,
        thread_id: uuid::Uuid,
    ) -> MailFuture<'a, Result<Option<ThreadDetail>, MailServiceError>> {
        (**self).get_thread(org, thread_id)
    }

    fn get_message<'a>(
        &'a self,
        org: OrgId,
        message_id: EmailMessageId,
    ) -> MailFuture<'a, Result<Option<MessageView>, MailServiceError>> {
        (**self).get_message(org, message_id)
    }

    fn get_attachment_key<'a>(
        &'a self,
        org: OrgId,
        attachment_id: uuid::Uuid,
    ) -> MailFuture<'a, Result<Option<AttachmentRef>, MailServiceError>> {
        (**self).get_attachment_key(org, attachment_id)
    }

    fn set_thread_seen<'a>(
        &'a self,
        org: OrgId,
        thread_id: uuid::Uuid,
        seen: bool,
        audit: AuditEvent,
    ) -> MailFuture<'a, Result<bool, MailServiceError>> {
        (**self).set_thread_seen(org, thread_id, seen, audit)
    }
}
