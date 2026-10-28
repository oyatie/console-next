//! 접속기록 for account reads (INF-02): the account list, one account and the
//! people directory carry names, contact and the linked employee, so each read
//! records the accounts shown. The adapter reads run on the pool, so the row is
//! written right after the read and before the response; a failed write fails
//! the read (nothing leaves unrecorded).
//! 고시 제2025-9호 §8① covers personal-information system access, including
//! a 취급자 reading their own data; the shared writer marks those `self_read`.

use console_identity_application::{UserPage, UserSummary};
use console_platform_authz::Principal;
use console_platform_db::with_audit;
use console_platform_request_context::audit_context::access_log::{AccessRecord, access_event};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use crate::RestError;

/// A page of accounts (`account.list_read`, or the directory's action).
pub(crate) async fn record_account_page_read(
    pool: &PgPool,
    principal: &Principal,
    action: &'static str,
    page: &UserPage,
) -> Result<(), RestError> {
    let ids: Vec<Uuid> = page.items.iter().map(|user| *user.id.as_uuid()).collect();
    record(pool, principal, action, "query".to_owned(), &ids).await
}

/// One account (`account.read`), with that account as the target.
pub(crate) async fn record_account_read(
    pool: &PgPool,
    principal: &Principal,
    user: &UserSummary,
) -> Result<(), RestError> {
    let id = *user.id.as_uuid();
    record(pool, principal, "account.read", id.to_string(), &[id]).await
}

async fn record(
    pool: &PgPool,
    principal: &Principal,
    action: &'static str,
    target_id: String,
    subject_ids: &[Uuid],
) -> Result<(), RestError> {
    let record = AccessRecord {
        action,
        target_type: "user",
        target_id,
        subject_ids,
        reader_subject: Some(*principal.user_id.as_uuid()),
        details: json!({}),
    };
    let event = access_event(principal, record).map_err(RestError::from_kernel)?;
    with_audit::<_, (), RestError>(pool, event, |_tx| Box::pin(async { Ok(()) })).await
}
