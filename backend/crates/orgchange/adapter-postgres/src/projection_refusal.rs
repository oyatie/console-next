//! Refusal proof for effective-date list filters; business state is untouched.
use crate::*;
impl PgOrgChangeStore {
    pub async fn record_date_filter_refusal(&self, actor: UserId) -> Result<(), PgOrgChangeError> {
        let org = current_org().map_err(KernelError::from)?;
        let event = audit(
            org,
            actor,
            "org_change.date_filter_refused",
            "temporal_read",
            org.to_string(),
            OffsetDateTime::now_utc(),
        )?
        .with_snapshots(None, Some(serde_json::json!({"code":"validation"})))
        .with_classification(AuditClassification {
            badges: None,
            anomaly: Some(true),
            reason: Some("validation".into()),
        });
        with_audit(&self.pool, event, |_tx| {
            Box::pin(async { Ok::<(), PgOrgChangeError>(()) })
        })
        .await
    }
}
