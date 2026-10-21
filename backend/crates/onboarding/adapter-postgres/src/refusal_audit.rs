//! Refusals commit an audit after the business transaction has rolled back.
use super::*;

impl PgOnboardingStore {
    pub(crate) async fn audit_refusal<T>(
        &self,
        actor: &OnboardingActor,
        result: Result<T, PgOnboardingError>,
    ) -> Result<T, PgOnboardingError> {
        if let Err(PgOnboardingError::Refused { code, fields, .. }) = &result {
            self.record_refusal(actor, code, fields).await?;
        }
        result
    }

    /// Record a refusal from the authenticated HTTP boundary without changing setup facts.
    ///
    /// # Errors
    /// Database faults; callers must fail closed if the audit cannot be recorded.
    pub async fn record_refusal(
        &self,
        actor: &OnboardingActor,
        code: &str,
        fields: &[&str],
    ) -> Result<(), PgOnboardingError> {
        let audit = event(
            actor,
            "tenant.onboarding_refused",
            json!({ "code": code, "fields": fields }),
            false,
        )?;
        with_audits(&self.pool, actor.org, move |_tx| {
            Box::pin(async move { Ok(((), vec![audit])) })
        })
        .await
    }
}
