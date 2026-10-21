use std::panic::AssertUnwindSafe;
use std::str::FromStr;

use cedar_policy::{Authorizer, Decision, Policy, PolicyId, PolicySet, Schema};
use console_kernel_core::OrgId;

use super::{
    AUTHORING_ACTIONS, AUTHORING_SCHEMA, OBJECT_POLICY_ACTION, PROPERTY_POLICY_ACTION,
    build_entities, build_request,
};

// ---------------------------------------------------------------------------
// Point-decision evaluation (simulate / authorize)
// ---------------------------------------------------------------------------

/// Server-loaded subject for a point decision.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SimSubject {
    pub org: OrgId,
    pub user_id: String,
    #[serde(default)]
    pub roles: Vec<String>,
    #[serde(default)]
    pub clearance_keys: Vec<String>,
}

/// Server-loaded resource (an ontology row) for a point decision.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SimResource {
    pub org: OrgId,
    pub resource_type: String,
    #[serde(default)]
    pub resource_id: Option<String>,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub legal_hold: Option<bool>,
}

/// One point-decision request.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SimRequest {
    pub subject: SimSubject,
    pub action: String,
    pub resource: SimResource,
    #[serde(default)]
    pub purpose: Option<String>,
    #[serde(default)]
    pub field: Option<String>,
}

/// Final effect of a point decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SimEffect {
    Allow,
    Deny,
}

impl SimEffect {
    #[must_use]
    pub const fn is_allow(self) -> bool {
        matches!(self, Self::Allow)
    }
}

/// Auditable outcome of [`simulate`]: the decision, the policy ids that
/// determined it (Cedar `reason`), and any evaluation-error diagnostics.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SimulationOutcome {
    pub effect: SimEffect,
    /// Policy ids Cedar reports as determining the decision (empty on a
    /// deny-by-omission, since no policy matched).
    pub determining_policies: Vec<String>,
    /// Cedar evaluation-error strings; a non-empty list forces `effect` to Deny
    /// (fail closed). Cedar's own decision is kept in `reason` for the what-if.
    pub errors: Vec<String>,
    pub reason: String,
}

impl SimulationOutcome {
    fn deny(reason: impl Into<String>) -> Self {
        Self {
            effect: SimEffect::Deny,
            determining_policies: Vec::new(),
            errors: Vec::new(),
            reason: reason.into(),
        }
    }
}

/// One authored policy: a stable id + its Cedar source text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthoredPolicy {
    pub id: String,
    pub text: String,
}

impl AuthoredPolicy {
    pub fn new(id: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            text: text.into(),
        }
    }
}

/// Evaluate `request` against the authored `policies` — the single evaluator
/// behind both `/policy/simulate` (what-if policy set) and `/policy/authorize`
/// (the org's live enforced set).
///
/// Fail-closed like [`engine::evaluate`]: any parse/build error becomes a
/// recorded Deny, an unknown action is a Deny (deny-by-omission), and the whole
/// Cedar call is `catch_unwind`-isolated so a Cedar panic can never escape as an
/// exception. Deny-by-omission is the default and `forbid` always wins, both by
/// Cedar's own authorization semantics.
///
/// [`engine::evaluate`]: super::engine::evaluate
#[must_use]
pub fn simulate(policies: &[AuthoredPolicy], request: &SimRequest) -> SimulationOutcome {
    match std::panic::catch_unwind(AssertUnwindSafe(|| {
        crate::cedar_stack::with_cedar_stack(|| simulate_inner(policies, request))
    })) {
        Ok(outcome) => outcome,
        Err(_) => SimulationOutcome::deny("cedar simulate panicked"),
    }
}

fn simulate_inner(policies: &[AuthoredPolicy], request: &SimRequest) -> SimulationOutcome {
    if !AUTHORING_ACTIONS.contains(&request.action.as_str()) {
        // Unknown action is not a declared schema action ⇒ deny-by-omission.
        return SimulationOutcome::deny(format!(
            "action {:?} is not authorizable; deny-by-omission",
            request.action
        ));
    }

    let schema = match Schema::from_str(AUTHORING_SCHEMA) {
        Ok(schema) => schema,
        Err(err) => {
            return SimulationOutcome::deny(format!("authoring schema parse failed: {err}"));
        }
    };

    let mut policy_set = PolicySet::new();
    for authored in policies {
        let policy_id = PolicyId::from_str(&authored.id)
            .unwrap_or_else(|_| PolicyId::from_str("p").expect("literal id is valid"));
        let policy = match Policy::parse(Some(policy_id), &authored.text) {
            Ok(policy) => policy,
            Err(err) => {
                // A malformed stored policy fails the WHOLE decision closed: we
                // never silently drop it and evaluate a narrower (more-permissive
                // for forbids) set.
                return SimulationOutcome::deny(format!(
                    "authored policy {:?} failed to parse: {err}",
                    authored.id
                ));
            }
        };
        if let Err(err) = policy_set.add(policy) {
            return SimulationOutcome::deny(format!(
                "authored policy {:?} could not be added: {err}",
                authored.id
            ));
        }
    }

    let entities = match build_entities(request, &schema) {
        Ok(entities) => entities,
        Err(reason) => return SimulationOutcome::deny(reason),
    };
    let cedar_request = match build_request(request, &schema) {
        Ok(cedar_request) => cedar_request,
        Err(reason) => return SimulationOutcome::deny(reason),
    };

    let response = Authorizer::new().is_authorized(&cedar_request, &policy_set, &entities);
    let determining_policies = response
        .diagnostics()
        .reason()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let errors = response
        .diagnostics()
        .errors()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    // SEC-S1 fail-closed (as engine.rs BW-28): Cedar SKIPS an erroring policy,
    // so a skipped `forbid` would let a matching permit win. Any evaluation
    // error is a Deny whatever Cedar decided; its decision stays in `reason`.
    if !errors.is_empty() {
        return SimulationOutcome {
            effect: SimEffect::Deny,
            reason: format!(
                "deny: policy evaluation error (fail closed); cedar decided {:?}",
                response.decision()
            ),
            determining_policies,
            errors,
        };
    }
    match response.decision() {
        Decision::Allow => SimulationOutcome {
            effect: SimEffect::Allow,
            reason: "allow: a permit matched and no forbid did".to_owned(),
            determining_policies,
            errors,
        },
        Decision::Deny => {
            let reason = if determining_policies.is_empty() {
                "deny-by-omission: no permit matched".to_owned()
            } else {
                "deny: a forbid matched (forbid always wins)".to_owned()
            };
            SimulationOutcome {
                effect: SimEffect::Deny,
                reason,
                determining_policies,
                errors,
            }
        }
    }
}

/// Object-policy row visibility: is this row visible to this subject under the
/// authored object policies? A row is hidden unless a `view` permit matches and
/// no `forbid` does (deny-by-omission).
#[must_use]
pub fn object_row_visible(
    policies: &[AuthoredPolicy],
    subject: SimSubject,
    resource: SimResource,
) -> bool {
    simulate(
        policies,
        &SimRequest {
            subject,
            action: OBJECT_POLICY_ACTION.to_owned(),
            resource,
            purpose: None,
            field: None,
        },
    )
    .effect
    .is_allow()
}

/// Property-policy field visibility: is `field` readable by this subject on this
/// row? A field is nulled unless a `read_field` permit matches and no forbid does.
#[must_use]
pub fn property_field_visible(
    policies: &[AuthoredPolicy],
    subject: SimSubject,
    resource: SimResource,
    field: impl Into<String>,
) -> bool {
    simulate(
        policies,
        &SimRequest {
            subject,
            action: PROPERTY_POLICY_ACTION.to_owned(),
            resource,
            purpose: None,
            field: Some(field.into()),
        },
    )
    .effect
    .is_allow()
}
