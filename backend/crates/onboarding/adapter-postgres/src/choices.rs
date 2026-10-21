//! Recorded setup choices: 이용약관 acceptance and setup-rail step skips.

use super::*;

impl PgOnboardingStore {
    /// 「부서 없이 진행」 (`org`) or 「직원은 나중에」 (`employees`), stored.
    ///
    /// # Errors
    /// `step_not_skippable`, `phase_not_setup`, or database faults.
    pub async fn skip_step(
        &self,
        actor: &OnboardingActor,
        step: &str,
    ) -> Result<(), PgOnboardingError> {
        let kind = match step {
            "org" => "ORG_STEP_SKIPPED",
            "employees" => "EMPLOYEES_STEP_DEFERRED",
            "roles" => "ROLES_STEP_SKIPPED",
            _ => {
                return self
                    .audit_refusal(
                        actor,
                        Err(refused(ErrorKind::Validation, "step_not_skippable", None)),
                    )
                    .await;
            }
        };
        self.record_choice(
            actor,
            kind,
            json!({ "step": step }),
            "tenant.setup_step_skip",
            "step_already_skipped",
        )
        .await
    }

    async fn record_choice(
        &self,
        actor: &OnboardingActor,
        kind: &'static str,
        payload: serde_json::Value,
        action: &'static str,
        duplicate: &'static str,
    ) -> Result<(), PgOnboardingError> {
        let refusal_actor = actor.clone();
        let actor = actor.clone();
        let result = with_phase_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                if action == "tenant.setup_step_skip" {
                    viewer::require_step(tx, &actor, payload["step"].as_str().unwrap_or("")).await?;
                } else {
                    viewer::require_ops(tx, &actor).await?;
                }
                if phase(tx, true).await? != TenantPhase::Setup {
                    return Err(refused(ErrorKind::Conflict, "phase_not_setup", None));
                }
                let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM tenant_phase_events WHERE kind = $1)")
                    .bind(kind)
                    .fetch_one(tx.as_mut())
                    .await?;
                if exists {
                    return Err(refused(ErrorKind::Conflict, duplicate, None));
                }
                sqlx::query(
                    "INSERT INTO tenant_phase_events (org_id, kind, actor_id, payload) \
                     VALUES (NULLIF(current_setting('app.current_org', true), '')::uuid, $1, $2, $3)",
                )
                .bind(kind)
                .bind(*actor.user.as_uuid())
                .bind(&payload)
                .execute(tx.as_mut())
                .await?;
                let audit = event(&actor, action, payload, true)?;
                Ok(((), vec![audit]))
            })
        })
        .await;
        self.audit_refusal(&refusal_actor, result).await
    }
}
