//! The locked, audited one-way start of operations.
use super::*;

impl PgOnboardingStore {
    /// Check live ops authority before starting a passkey ceremony; the write checks it again under lock.
    /// # Errors
    /// Cedar refusal or database faults, with refused decisions audited.
    pub async fn authorize_go_live(
        &self,
        actor: &OnboardingActor,
    ) -> Result<(), PgOnboardingError> {
        let a = actor.clone();
        let result = with_org_conn(&self.pool, a.org, move |tx| {
            Box::pin(async move { viewer::require_ops(tx, &a).await })
        })
        .await;
        self.audit_refusal(actor, result).await
    }

    /// 운영 시작. `step_up_verified` is the REST layer's verified passkey
    /// assertion for this request; `digest` must equal the preview the actor saw.
    ///
    /// # Errors
    /// `go_live_blocked` (fields = failing facts, remedy = the first blocker's
    /// fix), `preview_stale`, `phase_not_setup`, or database faults.
    pub async fn go_live(
        &self,
        actor: &OnboardingActor,
        digest: String,
        sole_holder_acknowledged: bool,
        step_up_verified: bool,
    ) -> Result<GoLiveDone, PgOnboardingError> {
        self.go_live_with_lines(
            actor,
            digest,
            Default::default(),
            sole_holder_acknowledged,
            step_up_verified,
        )
        .await
    }

    /// Start against a preview, returning the digest and codes of a fresh preview on conflict.
    /// # Errors
    /// The same refusals as `go_live`.
    pub async fn go_live_with_lines(
        &self,
        actor: &OnboardingActor,
        digest: String,
        seen: std::collections::BTreeMap<String, String>,
        sole_holder_acknowledged: bool,
        step_up_verified: bool,
    ) -> Result<GoLiveDone, PgOnboardingError> {
        let refusal_actor = actor.clone();
        let actor = actor.clone();
        let result = with_phase_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                let p = phase(tx, true).await?;
                viewer::require_ops(tx, &actor).await?;
                if p != TenantPhase::Setup {
                    return Err(refused(ErrorKind::Conflict, "phase_not_setup", None));
                }
                let (f, records, details) = facts::setup_facts(tx, (actor.org, *actor.user.as_uuid()), true).await?;
                let current = preview(&f, &records).with_details(details);
                let digest_matches = current.digest == digest;
                if !digest_matches {
                    let changed = console_onboarding_domain::changed_codes(&current, &digest, &seen);
                    return Err(PgOnboardingError::Refused { kind: ErrorKind::Conflict, code: "preview_stale", fields: Vec::new(), remedy: Some("reopen_go_live_preview"), details: Some(Box::new(json!({ "digest": current.digest, "changed_codes": changed }))) });
                }
                let super_admin = actor.roles.iter().any(|r| r == "SUPER_ADMIN");
                let failing = backstop(&f, super_admin, step_up_verified, sole_holder_acknowledged, digest_matches);
                let roles: Vec<&str> = actor.roles.iter().map(String::as_str).collect();
                let cedar = tenant_go_live::decide(
                    &actor.user.as_uuid().to_string(),
                    &actor.org.as_uuid().to_string(),
                    &roles,
                    tenant_go_live::GoLiveFacts {
                        phase_is_setup: true,
                        step_up: step_up_verified,
                        entities_ready: f.entities_ready(),
                        primary_workplaces_ready: f.primary_workplaces_ready(),
                        org_change_route_resolvable: f.org_change_route_resolvable(),
                        org_change_routed: f.org_change_routed,
                        other_eligible_holders: f.other_eligible_holders,
                        sole_holder_acknowledged,
                        security_contact_recorded: f.security_contact_recorded,
                        security_contact_store_available: f.security_contact_store_available,
                        terms_accepted: f.terms_accepted,
                        preview_digest_matches: digest_matches,
                    },
                );
                require_ready(&current, failing, cedar)?;
                let go_live_at: time::OffsetDateTime = sqlx::query_scalar(
                    "UPDATE tenant_phase SET phase = 'OPERATING', go_live_at = now(), go_live_by = $1, go_live_preview_digest = $2 \
                     WHERE org_id = NULLIF(current_setting('app.current_org', true), '')::uuid RETURNING go_live_at",
                )
                .bind(*actor.user.as_uuid())
                .bind(&digest)
                .fetch_one(tx.as_mut())
                .await?;
                sqlx::query("UPDATE legal_entities SET identity_locked_at = now() WHERE identity_locked_at IS NULL AND voided_at IS NULL")
                    .execute(tx.as_mut())
                    .await?;
                sqlx::query("UPDATE business_registrations SET identity_locked_at = now() WHERE identity_locked_at IS NULL AND voided_at IS NULL AND brn IS NOT NULL")
                    .execute(tx.as_mut())
                    .await?;
                let payload = json!({ "digest": digest, "setup_writes": f.setup_writes, "entities": f.entities,
                    "workplaces": f.workplaces, "employees": f.employees, "sole_holder": f.other_eligible_holders == 0 });
                sqlx::query(
                    "INSERT INTO tenant_phase_events (org_id, kind, actor_id, payload) \
                     VALUES (NULLIF(current_setting('app.current_org', true), '')::uuid, 'GO_LIVE', $1, $2)",
                )
                .bind(*actor.user.as_uuid())
                .bind(&payload)
                .execute(tx.as_mut())
                .await?;
                let notified = sqlx::query(
                    "INSERT INTO notifications (org_id, recipient_user_id, category, body, link, dedup_key) \
                     SELECT org_id, id, 'tenant.go_live', $1, \
                            jsonb_build_object('screen', 'settings/audit'), 'tenant.go_live:' || id \
                     FROM users WHERE is_active AND roles && ARRAY['EXECUTIVE', 'SUPER_ADMIN'] \
                     ON CONFLICT DO NOTHING",
                )
                .bind(go_live_notice(f.org_change_routed))
                .execute(tx.as_mut())
                .await?
                .rows_affected();
                let notified = i64::try_from(notified).unwrap_or(i64::MAX);
                let audit = event(&actor, "tenant.go_live", json!({ "payload": payload, "notified": notified }), false)?;
                let done = GoLiveDone { phase: "OPERATING", go_live_at, notified };
                console_platform_db::command_outcomes::set_result(tx, &serde_json::to_value(&done).map_err(|_| PgOnboardingError::from(DbError::Sqlx(sqlx::Error::Protocol("go-live result serialization failed".into()))))?).await?;
                Ok((done, vec![audit]))
            })
        })
        .await;
        self.audit_refusal(&refusal_actor, result).await
    }
}

/// Both engines must allow; diagnostics stay a refusal before any business write.
fn require_ready(
    current: &console_onboarding_domain::Preview,
    mut failing: Vec<&'static str>,
    cedar: Result<bool, String>,
) -> Result<(), PgOnboardingError> {
    if failing.is_empty() && cedar == Ok(true) {
        return Ok(());
    }
    let remedy = current
        .blockers
        .first()
        .and_then(|b| b.remedy)
        .or(match failing.first() {
            Some(&"step_up") => Some("passkey_step_up"),
            Some(&"sole_holder_acknowledged") => Some("acknowledge_sole_holder"),
            _ => None,
        });
    if let Err(reason) = &cedar {
        tracing::warn!(reason = %reason, "tenant_go_live cedar evaluation error");
        failing.push("cedar_error");
    }
    Err(PgOnboardingError::Refused {
        kind: ErrorKind::Conflict,
        code: "go_live_blocked",
        fields: failing,
        remedy,
        details: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_cedar_error_is_a_blocked_refusal_even_when_the_backstop_allows() {
        let current = preview(
            &console_onboarding_domain::SetupFacts::default(),
            &Default::default(),
        );
        let error = require_ready(&current, vec![], Err("missing fact".into()));
        assert!(matches!(error, Err(PgOnboardingError::Refused {
            kind: ErrorKind::Conflict, code: "go_live_blocked", fields, ..
        }) if fields == vec!["cedar_error"]));
        assert!(require_ready(&current, vec![], Ok(false)).is_err());
        assert!(require_ready(&current, vec![], Ok(true)).is_ok());
    }
}
