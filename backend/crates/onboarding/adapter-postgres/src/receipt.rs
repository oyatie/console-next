// SPDX-License-Identifier: LicenseRef-Proprietary
//! A receipt reads only the immutable go-live record, never today's setup facts.
use super::*;
use console_platform_authz::access::cedar::GO_LIVE_RECEIPT_READ;
use console_platform_authz::access::{NodePath, load_active_access_slice};

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct GoLiveReceipt {
    #[serde(with = "time::serde::rfc3339")]
    pub go_live_at: time::OffsetDateTime,
    pub go_live_by: uuid::Uuid,
    pub preview_digest: String,
    pub facts_snapshot_version: i32,
    pub facts_snapshot: Option<serde_json::Value>,
}

impl PgOnboardingStore {
    /// Historical facts are absent on receipts created before snapshot recording.
    /// # Errors
    /// Cedar refusal, `go_live_receipt_not_found`, or database faults.
    pub async fn receipt(
        &self,
        actor: &OnboardingActor,
    ) -> Result<GoLiveReceipt, PgOnboardingError> {
        let a = actor.clone();
        let result = with_org_conn(&self.pool, a.org, move |tx| {
            Box::pin(async move {
                let slice = load_active_access_slice(tx, a.org, *a.user.as_uuid(), time::OffsetDateTime::now_utc()).await?;
                if slice.allows(GO_LIVE_RECEIPT_READ, &NodePath::tenant(a.org)) != Ok(true) {
                    return Err(refused(ErrorKind::Forbidden, "forbidden", None));
                }
                sqlx::query_as("SELECT go_live_at, go_live_by, go_live_preview_digest AS preview_digest, go_live_facts_snapshot AS facts_snapshot, go_live_facts_snapshot_version AS facts_snapshot_version FROM tenant_phase WHERE org_id=$1 AND phase='OPERATING' AND go_live_at IS NOT NULL")
                    .bind(a.org.as_uuid()).fetch_optional(tx.as_mut()).await?
                    .ok_or_else(|| refused(ErrorKind::NotFound, "go_live_receipt_not_found", None))
            })
        }).await;
        self.audit_refusal(actor, result).await
    }
}
