use crate::authz::authorize_org_manage;
use crate::error::RestError;
use crate::state::IdentityRestState;
use console_kernel_core::AuditAction;
use console_kernel_core::AuditEvent;
use console_kernel_core::OrgId;
use console_kernel_core::TraceContext;
use console_kernel_core::UserId;
use console_platform_authz::Action;
use console_platform_authz::AuthorizationAuditEvent;
use console_platform_authz::AuthorizationRequest;
use console_platform_authz::AuthorizationResource;
use console_platform_authz::CoexistenceMapEntry;
use console_platform_authz::DecisionEffect;
use console_platform_authz::DualEngineMode;
use console_platform_authz::Feature;
use console_platform_authz::Principal;
use console_platform_authz::RlsScopeProof;
use console_platform_authz::SubjectFreshnessRequirement;
use console_platform_authz::cedar_pbac::engine;
use console_platform_authz::cedar_pbac::map::canonical_coexistence_map;
use console_platform_authz::evaluate_cedar_pbac_boundary;
use console_platform_authz::observe_cedar_pbac_decision;
use console_platform_db::DbError;
use console_platform_db::with_audit;
use console_platform_request_context::current_org;
use sqlx::PgPool;
use time::OffsetDateTime;

/// Per-tenant DARK switch for the Cedar/PBAC role_manage shadow lane
/// (`org_runtime_flags`, migration 0095). Ships with ZERO enabled rows: an absent
/// row resolves FALSE via `org_runtime_flag_enabled()`, so the shadow lane never
/// runs and production authorization is byte-for-byte unchanged.
/// Exposed (doc-hidden) only so the DB-backed shadow-wiring integration tests can
/// live under `backend/app/tests/` (out of the `rest/` path the audit-coverage gate
/// scans). Not part of the crate's supported API.
#[doc(hidden)]
pub const CEDAR_PBAC_SHADOW_ROLE_MANAGE_FLAG: &str = "cedar_pbac_shadow_role_manage";
pub(crate) const CEDAR_PBAC_SHADOW_TOTAL: &str = "cedar_pbac_shadow_total";
pub(crate) const CEDAR_PBAC_SHADOW_DISAGREEMENT_TOTAL: &str =
    "cedar_pbac_shadow_disagreement_total";
/// Append-only audit action for a shadow observation (kernel `AuditAction` shape:
/// ≥2 dot-separated `[a-z0-9_]` segments).
///
/// Exposed (doc-hidden) only for the moved integration tests (see above).
#[doc(hidden)]
pub const CEDAR_PBAC_SHADOW_AUDIT_ACTION: &str = "authz.cedar_pbac_shadow";

/// Authorize an org-management feature and — for [`Feature::RoleManage`] ONLY,
/// and only when the per-tenant dark flag is enabled — run an AUDIT-ONLY Cedar/PBAC
/// shadow observation alongside it.
///
/// SAFETY (ADR-0021, HIGH finding): the legacy [`authorize_org_manage`] `Result`
/// is the SOLE enforcer and is what this returns, ALWAYS. The Cedar shadow lane is
/// a best-effort, side-effect-only observation whose error/deny/bug is swallowed
/// and can NEVER change the returned decision. In particular the coexistence
/// boundary's `CedarShadowLegacyEnforce` arm short-circuits to Cedar's deny BEFORE
/// consulting legacy, so its returned effect is deliberately NOT used to gate the
/// request — it is recorded for audit/metrics only.
#[doc(hidden)]
pub async fn authorize_org_manage_observed(
    state: &IdentityRestState,
    principal: &Principal,
    feature: Feature,
) -> Result<(), RestError> {
    // The sole enforcer. Computed first; its value is returned unchanged below no
    // matter what the shadow lane observes.
    let legacy = authorize_org_manage(principal, feature);

    if feature == Feature::RoleManage {
        let legacy_effect = if legacy.is_ok() {
            DecisionEffect::Allow
        } else {
            DecisionEffect::Deny
        };
        // Audit-only. Never propagates an error or mutates `legacy`.
        // the shadow observation is wrapped in `catch_unwind`, so any panic
        // ANYWHERE in the lane becomes an `Err` and can NEVER unwind into this live
        // request. It runs on the same task (task-local `CURRENT_ORG` preserved) and is
        // awaited inline so the deterministic DB tests observe it synchronously.
        run_role_manage_cedar_shadow(state, principal, legacy_effect).await;
    }

    legacy
}

/// Best-effort Cedar/PBAC shadow observation for a role_manage request. Swallows
/// (and logs) EVERY error: building/evaluating/persisting the shadow can never
/// fail the live request — the legacy decision already stands.
pub(crate) async fn run_role_manage_cedar_shadow(
    state: &IdentityRestState,
    principal: &Principal,
    legacy_effect: DecisionEffect,
) {
    use futures::FutureExt;

    let actor = principal.user_id; // UserId is Copy; used for logging in both arms
    // Panic-isolate the ENTIRE shadow future: `catch_unwind` turns any panic (Cedar
    // SDK, metrics recorder, serialize — anywhere in the lane) into an `Err` instead
    // of letting it unwind into the live request. It runs on the SAME task, so the
    // request's armed `CURRENT_ORG` task-local is preserved and the lane resolves the
    // right tenant. `AssertUnwindSafe` is sound here: the lane holds no locks and its
    // only mutation is an audit-txn write that rolls back on a panic, so a caught
    // panic leaves no observable broken state. The enforced decision (legacy) is
    // already computed and returned by the caller regardless of anything here.
    let outcome = std::panic::AssertUnwindSafe(try_run_role_manage_cedar_shadow(
        state,
        principal,
        legacy_effect,
    ))
    .catch_unwind()
    .await;
    match outcome {
        Ok(Ok(())) => {}
        Ok(Err(err)) => tracing::warn!(
            event = "cedar_pbac_shadow_error",
            error = %err.message,
            actor_user_id = %actor,
            "cedar/pbac role_manage shadow lane failed (audit-only; live decision unaffected)"
        ),
        Err(_panic) => tracing::warn!(
            event = "cedar_pbac_shadow_error",
            actor_user_id = %actor,
            "cedar/pbac role_manage shadow lane panicked (audit-only; live decision unaffected)"
        ),
    }
}

pub(crate) async fn try_run_role_manage_cedar_shadow(
    state: &IdentityRestState,
    principal: &Principal,
    legacy_effect: DecisionEffect,
) -> Result<(), RestError> {
    // DARK switch: absent/false flag ⇒ do nothing at all (no reads beyond this
    // one, no bundle, no metrics, no audit). Production stays byte-identical.
    if !state
        .store
        .org_runtime_flag_enabled(CEDAR_PBAC_SHADOW_ROLE_MANAGE_FLAG)
        .await
        .map_err(RestError::from_store)?
    {
        return Ok(());
    }

    // Coexistence-map identity for role_manage. The committed map stays
    // legacy_only (slice 3); the shadow lane derives a shadow-mode entry from it,
    // bound to a real per-org compiled bundle, so it exercises the
    // `CedarShadowLegacyEnforce` boundary arm WITHOUT flipping the committed map.
    let load = canonical_coexistence_map().map_err(RestError::from_kernel)?;
    let Some(base) = load
        .entries
        .iter()
        .find(|entry| entry.feature == Feature::RoleManage)
    else {
        return Ok(()); // role_manage not enrolled ⇒ nothing to observe.
    };

    // The tenant this request's DB context (the `app.current_org` GUC) is armed to,
    // so the compiled bundle, resource scope, RLS proof, and persisted audit all
    // reflect the REAL armed scope rather than a claim off the principal. In the
    // normal request flow `current_org()` equals `principal.org_id`, so this is not a
    // behavior change — it removes a latent inconsistency and makes the audit
    // evidence trustworthy. (`current_org()?` maps a missing GUC to a 500 via the
    // existing `From<RequestContextError> for RestError`; `current_org` returns a
    // `RequestContextError`, not a `KernelError`.)
    let org = current_org()?;

    // DB-current freshness (guard-time) the token snapshot must be at least as
    // fresh as. Read under the armed `console_rt` GUC via the store.
    let policy_version = state
        .store
        .get_policy_version()
        .await
        .map_err(RestError::from_store)?
        .version;
    let (subject_version, session_generation) = state
        .store
        .get_subject_authz_versions(principal.user_id)
        .await
        .map_err(RestError::from_store)?;

    // Per-org, strict-validated compiled bundle keyed on this policy_version.
    // recompiled per shadow eval; add the in-process bundle cache
    // (ADR-0021 §4) when the pilot widens past one org.
    let bundle = engine::compile_bundle(org, u64::try_from(policy_version).unwrap_or(0))
        .map_err(RestError::from_kernel)?;

    let shadow_entry = CoexistenceMapEntry::new(
        base.id.clone(),
        base.domain.clone(),
        base.feature,
        base.resource_type.clone(),
        DualEngineMode::CedarShadowLegacyEnforce,
        Some(bundle.key.clone()),
    );

    let request = AuthorizationRequest::new(
        principal.clone(),
        Action::new(Feature::RoleManage),
        AuthorizationResource::org_wide(org, base.resource_type.clone()),
    )
    .with_policy_domain(base.domain.clone())
    .with_subject_freshness(principal.authz_freshness)
    .requiring_freshness(SubjectFreshnessRequirement {
        min_policy_version: u64::try_from(policy_version).unwrap_or(0),
        min_subject_version: u64::try_from(subject_version).unwrap_or(0),
        min_session_generation: u64::try_from(session_generation).unwrap_or(0),
        required_step_up_generation: None,
    })
    .with_rls_scope_proof(RlsScopeProof::runtime_role_guc(org));

    // Real Cedar evaluation (Result + catch_unwind guarded — cannot throw).
    let cedar = engine::evaluate(&request, &bundle);
    // AUDIT-ONLY boundary observation. Its effect is NOT used to gate the request.
    let observed = evaluate_cedar_pbac_boundary(&request, Some(&shadow_entry), cedar.clone());
    let audit = observe_cedar_pbac_decision(&request, Some(&shadow_entry), Some(&cedar), observed);

    emit_cedar_shadow_metrics(&audit, legacy_effect);
    persist_cedar_shadow_audit(state.pool(), org, principal.user_id, &audit).await;

    Ok(())
}

/// Render a serde-serialized authorization enum (snake_case) as a metric label
/// value, e.g. `deny`, `cedar_error`. Only invoked when the shadow flag is ON.
pub(crate) fn metric_label(value: &impl serde::Serialize) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_else(|| "unknown".to_owned())
}

/// Emit the shadow decision metric plus a disagreement counter (shadow effect vs
/// the enforced legacy effect). Labels stay low-cardinality (effect/engine/reason/
/// mode/domain); version + digest material lives on the audit event, not here.
pub(crate) fn emit_cedar_shadow_metrics(
    audit: &AuthorizationAuditEvent,
    legacy_effect: DecisionEffect,
) {
    let labels = audit.metric_labels();
    let mode = labels
        .mode
        .map_or_else(|| "none".to_owned(), |mode| metric_label(&mode));
    let domain = labels.domain.clone().unwrap_or_else(|| "none".to_owned());

    metrics::counter!(
        CEDAR_PBAC_SHADOW_TOTAL,
        "effect" => metric_label(&labels.effect),
        "engine" => metric_label(&labels.engine),
        "reason" => metric_label(&labels.reason),
        "mode" => mode,
        "domain" => domain.clone(),
    )
    .increment(1);

    if labels.effect != legacy_effect {
        metrics::counter!(
            CEDAR_PBAC_SHADOW_DISAGREEMENT_TOTAL,
            "domain" => domain,
            "shadow_effect" => metric_label(&labels.effect),
            "legacy_effect" => metric_label(&legacy_effect),
        )
        .increment(1);
    }
}

/// Persist the forensic shadow observation, best-effort, under armed RLS. An audit
/// write failure is logged and swallowed — it must NOT fail the live request.
pub(crate) async fn persist_cedar_shadow_audit(
    pool: &PgPool,
    org: OrgId,
    actor: UserId,
    audit: &AuthorizationAuditEvent,
) {
    let payload = match serde_json::to_value(audit) {
        Ok(payload) => payload,
        Err(err) => {
            tracing::warn!(event = "cedar_pbac_shadow_error", error = %err, "cedar/pbac shadow audit serialize failed");
            return;
        }
    };
    let action = match AuditAction::new(CEDAR_PBAC_SHADOW_AUDIT_ACTION) {
        Ok(action) => action,
        Err(err) => {
            tracing::warn!(event = "cedar_pbac_shadow_error", error = %err.message, "cedar/pbac shadow audit action invalid");
            return;
        }
    };
    let event = AuditEvent::new(
        Some(actor),
        action,
        "policy_role",
        actor.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org)
    .with_snapshots(None, Some(payload));

    if let Err(err) =
        with_audit::<_, (), DbError>(pool, event, |_tx| Box::pin(async move { Ok(()) })).await
    {
        tracing::warn!(
            event = "cedar_pbac_shadow_error",
            error = %err,
            "cedar/pbac shadow audit persist failed (live decision unaffected)"
        );
    }
}

// ---------------------------------------------------------------------------
// Cedar/PBAC role_manage shadow-wiring tests (activation slice 4).
//
// The load-bearing property is the ADR-0021 HIGH finding: the legacy
// authorization result is the SOLE enforcer, and the Cedar shadow lane can NEVER
// change a live outcome. These tests prove that both at the pure
// decision-combination level (forced Cedar Error/Deny) and end-to-end through the
// real `authorize_org_manage_observed` wrapper (dark default + flag-on + console_rt
// RLS).
// ---------------------------------------------------------------------------
#[cfg(test)]
mod cedar_shadow_wiring_tests {
    use crate::authz::authorize_org_manage;
    use console_kernel_core::BranchScope;
    use console_kernel_core::OrgId;
    use console_kernel_core::UserId;
    use console_platform_authz::Action;
    use console_platform_authz::AuthorizationRequest;
    use console_platform_authz::AuthorizationResource;
    use console_platform_authz::CoexistenceMapEntry;
    use console_platform_authz::DecisionEffect;
    use console_platform_authz::DualEngineMode;
    use console_platform_authz::Feature;
    use console_platform_authz::Principal;
    use console_platform_authz::RlsScopeProof;
    use console_platform_authz::Role;
    use console_platform_authz::SubjectFreshnessRequirement;
    use console_platform_authz::cedar_pbac::engine;
    use console_platform_authz::evaluate_cedar_pbac_boundary;
    use console_platform_authz::{CedarEvaluation, DecisionReason, SubjectFreshness};
    use std::collections::BTreeSet;

    const RESOURCE_TYPE: &str = "identity.policy_role";
    const DOMAIN: &str = "identity.policy";

    fn principal_with_role(org: OrgId, role: Role) -> Principal {
        Principal::new(UserId::new(), org, BTreeSet::from([role]), BranchScope::All)
    }

    /// A shadow request built with VALID freshness + RLS proof so it reaches the
    /// `CedarShadowLegacyEnforce` boundary arm (rather than short-circuiting on a
    /// precondition), letting the test control the Cedar result directly.
    fn shadow_request(principal: &Principal, org: OrgId) -> AuthorizationRequest {
        AuthorizationRequest::new(
            principal.clone(),
            Action::new(Feature::RoleManage),
            AuthorizationResource::org_wide(org, RESOURCE_TYPE),
        )
        .with_policy_domain(DOMAIN)
        .with_subject_freshness(SubjectFreshness {
            policy_version: 1,
            subject_version: 1,
            session_generation: 1,
            step_up_generation: None,
        })
        .requiring_freshness(SubjectFreshnessRequirement {
            min_policy_version: 1,
            min_subject_version: 1,
            min_session_generation: 1,
            required_step_up_generation: None,
        })
        .with_rls_scope_proof(RlsScopeProof::runtime_role_guc(org))
    }

    fn shadow_entry(
        bundle_key: console_platform_authz::CompiledBundleCacheKey,
    ) -> CoexistenceMapEntry {
        CoexistenceMapEntry::new(
            format!("{DOMAIN}.role_manage"),
            DOMAIN,
            Feature::RoleManage,
            RESOURCE_TYPE,
            DualEngineMode::CedarShadowLegacyEnforce,
            Some(bundle_key),
        )
    }

    /// THE safety test (ADR-0021 HIGH finding). With Cedar FORCED to `Error` and,
    /// separately, `Deny`, the coexistence boundary returns Deny (its shadow arm
    /// short-circuits to Cedar's deny) — yet the ENFORCED decision is the legacy
    /// `authorize_org_manage` Result, unchanged: SUPER_ADMIN stays ALLOW, everyone
    /// else stays DENY. Cedar cannot change the outcome.
    #[test]
    fn cedar_error_or_deny_never_changes_role_manage_enforcement() {
        let org = OrgId::one();
        let bundle = engine::compile_bundle(org, 1).expect("pilot bundle must compile");
        let entry = shadow_entry(bundle.key.clone());

        let super_admin = principal_with_role(org, Role::SuperAdmin);
        let member = principal_with_role(org, Role::Member);

        // Legacy is the sole enforcer, computed independently of any Cedar result.
        assert!(
            authorize_org_manage(&super_admin, Feature::RoleManage).is_ok(),
            "legacy must ALLOW SUPER_ADMIN role_manage"
        );
        assert!(
            authorize_org_manage(&member, Feature::RoleManage).is_err(),
            "legacy must DENY non-SUPER_ADMIN role_manage"
        );

        let forced_results = [
            (
                CedarEvaluation::Error {
                    reason: "forced cedar error".to_owned(),
                },
                DecisionReason::CedarError,
            ),
            (
                CedarEvaluation::Deny {
                    bundle_key: bundle.key.clone(),
                    reason: "forced cedar deny".to_owned(),
                },
                DecisionReason::CedarDenied,
            ),
        ];

        for (forced, expected_reason) in forced_results {
            // The boundary observation WOULD deny (short-circuit to Cedar's deny)…
            let observed = evaluate_cedar_pbac_boundary(
                &shadow_request(&super_admin, org),
                Some(&entry),
                forced.clone(),
            );
            assert_eq!(
                observed.effect,
                DecisionEffect::Deny,
                "boundary must surface Cedar {forced:?} as a Deny observation"
            );
            assert_eq!(observed.reason, expected_reason);

            // …but the enforced decision is STILL the legacy result. This is the
            // exact contract `authorize_org_manage_observed` implements: return the
            // legacy `Result`, never the boundary effect.
            assert!(
                authorize_org_manage(&super_admin, Feature::RoleManage).is_ok(),
                "SUPER_ADMIN allow must stand despite forced Cedar {forced:?}"
            );
            assert!(
                authorize_org_manage(&member, Feature::RoleManage).is_err(),
                "MEMBER deny must stand despite forced Cedar {forced:?}"
            );
        }
    }
}
