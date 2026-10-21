//! Invalid read coordinates leave business facts untouched and record their refusal code.
use crate::{PgEntityError, PgEntityStore};
use console_entity_application::Actor;
use console_entity_domain::Refusal;
use console_kernel_core::{AuditAction, AuditClassification, AuditEvent};
use console_platform_db::with_audit;
use serde_json::json;
impl PgEntityStore {
    /// # Errors
    /// Audit persistence faults; no unaudited temporal refusal is returned.
    pub async fn record_temporal_refusal(
        &self,
        actor: &Actor,
        refusal: &Refusal,
    ) -> Result<(), PgEntityError> {
        let event = AuditEvent::new(
            Some(actor.user),
            AuditAction::new("entity.temporal_read_refused").map_err(Refusal::from)?,
            "temporal_read",
            actor.org.to_string(),
            actor.trace.clone(),
            time::OffsetDateTime::now_utc(),
        )
        .with_org(actor.org)
        .with_snapshots(
            None,
            Some(json!({"code":refusal.code,"fields":refusal.fields})),
        )
        .with_classification(AuditClassification {
            badges: None,
            anomaly: Some(true),
            reason: Some(refusal.code.into()),
        });
        with_audit(&self.pool, event, |_tx| {
            Box::pin(async { Ok::<(), PgEntityError>(()) })
        })
        .await
    }
}
