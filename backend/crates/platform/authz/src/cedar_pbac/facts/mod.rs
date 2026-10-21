//! Server-computed facts for Cedar SoD decisions (decisions D0.1 §3–4).
//!
//! A use case computes every fact inside its decision transaction, under
//! `SELECT … FOR UPDATE` on the subject row, and never from client input. The
//! facts go into the Cedar context as required attributes of the action's
//! [`ActionSchema`](super::action_schema::ActionSchema); Cedar's runtime request
//! validation turns a missing, mistyped or undeclared fact into
//! [`CedarEvaluation::Error`], which every caller treats as a deny.

use std::collections::{BTreeMap, BTreeSet};
use std::panic::AssertUnwindSafe;

use cedar_policy::RestrictedExpression;

use super::engine::{CompiledBundle, evaluate_inner};

/// The scope-grant fact block (ED §3.11, decisions #15).
pub mod scope;
/// The shared second-person fact block (BW-29).
pub mod second_person;
use super::{AuthorizationRequest, CedarEvaluation};

/// Context names the engine fills from `AuthorizationContext`.
const ENVELOPE: [&str; 2] = ["purpose", "channel"];

/// One fact value, typed like [`FactType`](super::action_schema::FactType).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FactValue {
    Bool(bool),
    Long(i64),
    String(String),
    StringSet(BTreeSet<String>),
}

impl FactValue {
    fn cedar(&self) -> RestrictedExpression {
        match self {
            Self::Bool(value) => RestrictedExpression::new_bool(*value),
            Self::Long(value) => RestrictedExpression::new_long(*value),
            Self::String(value) => RestrictedExpression::new_string(value.clone()),
            Self::StringSet(values) => RestrictedExpression::new_set(
                values.iter().cloned().map(RestrictedExpression::new_string),
            ),
        }
    }
}

/// The facts of one decision, by name. Setting a name twice keeps the last
/// value; the set is what Cedar validates against the action schema.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Facts(BTreeMap<&'static str, FactValue>);

impl Facts {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn with(mut self, name: &'static str, value: FactValue) -> Self {
        self.0.insert(name, value);
        self
    }

    #[must_use]
    pub fn bool(self, name: &'static str, value: bool) -> Self {
        self.with(name, FactValue::Bool(value))
    }

    #[must_use]
    pub fn long(self, name: &'static str, value: i64) -> Self {
        self.with(name, FactValue::Long(value))
    }

    #[must_use]
    pub fn string(self, name: &'static str, value: impl Into<String>) -> Self {
        self.with(name, FactValue::String(value.into()))
    }

    #[must_use]
    pub fn get(&self, name: &str) -> Option<&FactValue> {
        self.0.get(name)
    }
}

/// Evaluate `request` with `facts` in the Cedar context. Fail-closed exactly
/// like [`super::engine::evaluate`], plus request validation of every fact.
#[must_use]
pub fn evaluate_with_facts(
    request: &AuthorizationRequest,
    bundle: &CompiledBundle,
    facts: &Facts,
) -> CedarEvaluation {
    // The optional envelope is filled from the request, never from a fact.
    if let Some(name) = ENVELOPE.iter().find(|name| facts.0.contains_key(*name)) {
        return CedarEvaluation::Error {
            reason: format!("cedar fact {name} shadows the request envelope"),
        };
    }
    let pairs = facts
        .0
        .iter()
        .map(|(name, value)| ((*name).to_owned(), value.cedar()))
        .collect();
    evaluate_with_context(request, bundle, pairs)
}

/// The engine's evaluation with `facts` in the Cedar context. Nothing escapes:
/// any error becomes [`CedarEvaluation::Error`], and so does a Cedar panic.
pub(super) fn evaluate_with_context(
    request: &AuthorizationRequest,
    bundle: &CompiledBundle,
    facts: Vec<(String, RestrictedExpression)>,
) -> CedarEvaluation {
    match std::panic::catch_unwind(AssertUnwindSafe(|| {
        crate::cedar_stack::with_cedar_stack(|| evaluate_inner(request, bundle, facts))
    })) {
        Ok(Ok(evaluation)) => evaluation,
        Ok(Err(reason)) => CedarEvaluation::Error { reason },
        Err(_) => CedarEvaluation::Error {
            reason: "cedar evaluation panicked".to_owned(),
        },
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use std::collections::BTreeSet;

    use console_kernel_core::{BranchScope, OrgId, UserId};

    use super::{Facts, evaluate_with_facts};
    use crate::cedar_pbac::action_schema::{ActionSchema, FactType, RequiredFact};
    use crate::{
        Action, AuthorizationRequest, AuthorizationResource, CedarEvaluation, Feature, Principal,
        Role,
    };

    const FACTS: &[RequiredFact] = &[
        RequiredFact {
            name: "other_eligible_holders",
            ty: FactType::Long,
        },
        RequiredFact {
            name: "step_up",
            ty: FactType::Bool,
        },
    ];

    const SOD: ActionSchema = ActionSchema {
        feature: Feature::RoleManage,
        version: "test-facts-v1",
        facts: FACTS,
        policies: "permit(principal, action == Action::\"role_manage\", resource)\nwhen { context.step_up };\nforbid(principal, action == Action::\"role_manage\", resource)\nwhen { context.other_eligible_holders > 0 };\n",
    };

    fn request() -> AuthorizationRequest {
        let principal = Principal::new(
            UserId::new(),
            OrgId::one(),
            BTreeSet::from([Role::SuperAdmin]),
            BranchScope::All,
        );
        AuthorizationRequest::new(
            principal,
            Action::new(Feature::RoleManage),
            AuthorizationResource::org_wide(OrgId::one(), "role"),
        )
    }

    fn decide(facts: &Facts) -> CedarEvaluation {
        let bundle = SOD.compile(OrgId::one(), 1, SOD.policies).unwrap();
        evaluate_with_facts(&request(), &bundle, facts)
    }

    #[test]
    fn complete_facts_reach_the_policies() {
        let sole = Facts::new().long("other_eligible_holders", 0);
        assert!(matches!(
            decide(&sole.clone().bool("step_up", true)),
            CedarEvaluation::Allow { .. }
        ));
        assert!(matches!(
            decide(&sole.bool("step_up", false)),
            CedarEvaluation::Deny { .. }
        ));
        let other = Facts::new()
            .long("other_eligible_holders", 1)
            .bool("step_up", true);
        assert!(matches!(decide(&other), CedarEvaluation::Deny { .. }));
    }

    #[test]
    fn a_missing_mistyped_or_extra_fact_is_an_error() {
        let base = Facts::new().long("other_eligible_holders", 0);
        for facts in [
            base.clone(),
            base.clone().string("step_up", "true"),
            base.clone()
                .bool("step_up", true)
                .bool("client_says_ok", true),
            base.bool("step_up", true).string("purpose", "x"),
        ] {
            let got = decide(&facts);
            assert!(
                matches!(got, CedarEvaluation::Error { .. }),
                "{facts:?}: {got:?}"
            );
        }
    }
}
