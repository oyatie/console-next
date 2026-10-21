//! Per-action required-fact Cedar schemas (BW-28; decisions D0.1 §3).
//!
//! Each SoD-governed action declares its own schema, and **every fact is a
//! required context attribute** (no `?`). The engine passes the bundle schema to
//! `Request::new`, so Cedar's runtime request validation rejects a request that
//! is missing a fact, carries a mistyped one, or adds an undeclared one, and
//! [`super::engine::evaluate`] records that as `CedarEvaluation::Error`.
//!
//! Only the non-fact envelope (`purpose`, `channel`) stays optional, because the
//! engine fills it from `AuthorizationContext` when present. Facts are computed
//! by the server inside the decision transaction (D0.1 §4); thresholds arrive
//! as resolved settings values, never as policy literals.

use std::panic::AssertUnwindSafe;

use console_kernel_core::{KernelError, OrgId};

use super::actions::ACTION_SCHEMAS;
use super::engine::{CompiledBundle, SHARED_ENTITY_SCHEMA, compile_bundle_from_sources};
use crate::Feature;

/// Cedar type of one required fact.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FactType {
    Bool,
    Long,
    String,
    StringSet,
}

impl FactType {
    const fn cedar(self) -> &'static str {
        match self {
            Self::Bool => "Bool",
            Self::Long => "Long",
            Self::String => "String",
            Self::StringSet => "Set<String>",
        }
    }
}

/// One server-computed fact an action's policies may read as `context.<name>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequiredFact {
    pub name: &'static str,
    pub ty: FactType,
}

/// The required-fact schema of one enrolled action. The Cedar action id is
/// [`Feature::as_str`], the same id the engine evaluates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActionSchema {
    pub feature: Feature,
    /// Schema identity label for the bundle cache key; bump it with the facts
    /// or the policies.
    pub version: &'static str,
    pub facts: &'static [RequiredFact],
    /// This action's own `permit`/`forbid` rules (D0.1 §3 per-action emission).
    /// The bundle declares only this action, so a rule naming another action, or
    /// `action in [...]`, fails strict validation and never activates.
    pub policies: &'static str,
}

/// The enrolled schema for `feature`, if it is a Cedar-only SoD action.
#[must_use]
pub fn action_schema(feature: Feature) -> Option<&'static ActionSchema> {
    ACTION_SCHEMAS
        .iter()
        .find(|schema| schema.feature == feature)
}

/// Compile the Cedar-only bundle of an enrolled action from its own policies.
/// An action that is not enrolled has no bundle: `Err`, so callers fail closed.
pub fn compile_action_bundle(
    org_id: OrgId,
    policy_version: u64,
    feature: Feature,
) -> Result<CompiledBundle, KernelError> {
    let schema = action_schema(feature).ok_or_else(|| {
        KernelError::validation(format!(
            "cedar action {} has no enrolled schema",
            feature.as_str()
        ))
    })?;
    schema.compile(org_id, policy_version, schema.policies)
}

impl ActionSchema {
    /// The `.cedarschema` source: shared entities plus this action with every
    /// fact required. A duplicate fact, or one named like the envelope, makes
    /// the schema fail to parse, so it can never activate.
    #[must_use]
    pub fn cedar_schema(&self) -> String {
        let facts: String = self
            .facts
            .iter()
            .map(|fact| format!("    \"{}\": {},\n", fact.name, fact.ty.cedar()))
            .collect();
        format!(
            "{SHARED_ENTITY_SCHEMA}\n\naction \"{action}\" appliesTo {{\n  principal: [Subject],\n  resource: [Resource],\n  context: {{\n    \"purpose\"?: String,\n    \"channel\"?: String,\n{facts}  }}\n}};\n",
            action = self.feature.as_str()
        )
    }

    /// Compile `policy_src` against this schema. Fail-closed and panic-safe like
    /// [`super::engine::compile_bundle_for_feature`].
    pub fn compile(
        &self,
        org_id: OrgId,
        policy_version: u64,
        policy_src: &str,
    ) -> Result<CompiledBundle, KernelError> {
        std::panic::catch_unwind(AssertUnwindSafe(|| {
            compile_bundle_from_sources(
                org_id,
                policy_version,
                self.version,
                &self.cedar_schema(),
                policy_src,
            )
        }))
        .unwrap_or_else(|_| {
            Err(KernelError::validation(
                "cedar action-schema bundle compilation panicked".to_owned(),
            ))
        })
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use std::collections::{BTreeSet, HashSet};
    use std::str::FromStr;

    use cedar_policy::{Context, EntityUid, Request, RestrictedExpression, Schema};
    use console_kernel_core::{BranchScope, OrgId, UserId};

    use super::{ACTION_SCHEMAS, ActionSchema, FactType, RequiredFact, compile_action_bundle};
    use crate::cedar_pbac::SubjectFreshness;
    use crate::cedar_pbac::engine::{ROLE_MANAGE_SCHEMA, compile_bundle_from_sources, evaluate};
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
        version: "test-sod-v1",
        facts: FACTS,
        policies: SOD_POLICY,
    };

    const SOD_POLICY: &str = "permit(principal, action == Action::\"role_manage\", resource)\nwhen { principal.roles.contains(\"SUPER_ADMIN\") && context.step_up };\nforbid(principal, action == Action::\"role_manage\", resource)\nwhen { context.other_eligible_holders > 0 };\n";

    fn request(role: Role, subject_version: u64) -> AuthorizationRequest {
        let principal = Principal::new(
            UserId::new(),
            OrgId::one(),
            BTreeSet::from([role]),
            BranchScope::All,
        );
        AuthorizationRequest::new(
            principal,
            Action::new(Feature::RoleManage),
            AuthorizationResource::org_wide(OrgId::one(), "role"),
        )
        .with_subject_freshness(SubjectFreshness {
            subject_version,
            ..SubjectFreshness::default()
        })
    }

    fn cedar_request(schema: &Schema, pairs: Vec<(&str, RestrictedExpression)>) -> bool {
        let context = Context::from_pairs(pairs.into_iter().map(|(k, v)| (k.to_owned(), v)))
            .expect("context pairs");
        Request::new(
            EntityUid::from_str("Subject::\"u\"").unwrap(),
            EntityUid::from_str("Action::\"role_manage\"").unwrap(),
            EntityUid::from_str("Resource::\"role\"").unwrap(),
            context,
            Some(schema),
        )
        .is_ok()
    }

    #[test]
    fn every_fact_is_a_required_attribute() {
        let schema = SOD.cedar_schema();
        assert!(
            schema.contains("\"other_eligible_holders\": Long,"),
            "{schema}"
        );
        assert!(schema.contains("\"step_up\": Bool,"), "{schema}");
        for fact in FACTS {
            assert!(!schema.contains(&format!("\"{}\"?", fact.name)), "{schema}");
        }
        SOD.compile(OrgId::one(), 1, SOD_POLICY)
            .expect("required-fact bundle must strict-validate");
    }

    #[test]
    fn request_validation_rejects_missing_mistyped_or_extra_facts() {
        let schema = Schema::from_str(&SOD.cedar_schema()).unwrap();
        let holders = || ("other_eligible_holders", RestrictedExpression::new_long(0));
        let step_up = || ("step_up", RestrictedExpression::new_bool(true));
        assert!(cedar_request(&schema, vec![holders(), step_up()]));
        assert!(!cedar_request(&schema, vec![holders()]), "missing fact");
        assert!(!cedar_request(&schema, vec![]), "no facts");
        let mistyped = (
            "step_up",
            RestrictedExpression::new_string("yes".to_owned()),
        );
        assert!(
            !cedar_request(&schema, vec![holders(), mistyped]),
            "mistyped"
        );
        let extra = ("client_says_ok", RestrictedExpression::new_bool(true));
        assert!(
            !cedar_request(&schema, vec![holders(), step_up(), extra]),
            "undeclared"
        );
    }

    #[test]
    fn cedar_fail_closed_missing_fact_is_an_error_not_a_decision() {
        let bundle = SOD.compile(OrgId::one(), 1, SOD_POLICY).unwrap();
        // The request carries no facts, so request validation must refuse it.
        let got = evaluate(&request(Role::SuperAdmin, 1), &bundle);
        assert!(matches!(got, CedarEvaluation::Error { .. }), "{got:?}");
    }

    #[test]
    fn cedar_fail_closed_erroring_forbid_never_yields_allow() {
        // Strict validation cannot see i64 overflow; at runtime the forbid errors
        // and Cedar skips it. Before BW-28 the permit then produced Allow.
        let overflow = "when { principal.subject_version + 9223372036854775807 > 0 };\n";
        let permit = "permit(principal, action == Action::\"role_manage\", resource)\nwhen { principal.roles.contains(\"SUPER_ADMIN\") };\n";
        let forbid =
            format!("forbid(principal, action == Action::\"role_manage\", resource)\n{overflow}");
        let erroring_permit =
            format!("permit(principal, action == Action::\"role_manage\", resource)\n{overflow}");
        for policies in [format!("{permit}{forbid}"), erroring_permit] {
            let bundle = compile_bundle_from_sources(
                OrgId::one(),
                1,
                "test-overflow-v1",
                ROLE_MANAGE_SCHEMA,
                &policies,
            )
            .expect("overflow is invisible to strict validation");
            let got = evaluate(&request(Role::SuperAdmin, 1), &bundle);
            assert!(
                matches!(got, CedarEvaluation::Error { .. }),
                "{policies}: {got:?}"
            );
        }
        // Without the error path the same permit still allows (control case).
        let bundle = compile_bundle_from_sources(
            OrgId::one(),
            1,
            "test-overflow-v1",
            ROLE_MANAGE_SCHEMA,
            permit,
        )
        .unwrap();
        let got = evaluate(&request(Role::SuperAdmin, 1), &bundle);
        assert!(matches!(got, CedarEvaluation::Allow { .. }), "{got:?}");
    }

    #[test]
    fn duplicate_or_envelope_named_fact_cannot_activate() {
        const DUPLICATE: &[RequiredFact] = &[FACTS[1], FACTS[1]];
        const ENVELOPE: &[RequiredFact] = &[RequiredFact {
            name: "purpose",
            ty: FactType::String,
        }];
        for facts in [DUPLICATE, ENVELOPE] {
            let schema = ActionSchema { facts, ..SOD };
            assert!(
                schema.compile(OrgId::one(), 1, SOD_POLICY).is_err(),
                "{facts:?}"
            );
        }
    }

    #[test]
    fn every_registered_action_schema_is_unique_and_activates() {
        let mut seen = HashSet::new();
        for schema in ACTION_SCHEMAS {
            assert!(
                seen.insert(schema.feature),
                "{:?} registered twice",
                schema.feature
            );
            assert!(
                !schema.facts.is_empty(),
                "{:?} declares no facts",
                schema.feature
            );
            compile_action_bundle(OrgId::one(), 1, schema.feature)
                .unwrap_or_else(|err| panic!("{:?}: {err}", schema.feature));
        }
    }

    #[test]
    fn an_unenrolled_action_has_no_bundle() {
        assert!(compile_action_bundle(OrgId::one(), 1, Feature::RoleManage).is_err());
    }

    #[test]
    fn a_policy_for_another_action_cannot_activate() {
        let other = "permit(principal, action == Action::\"user_manage\", resource);\n";
        let grouped = "permit(principal, action in [Action::\"role_manage\", Action::\"user_manage\"], resource);\n";
        for policies in [other, grouped] {
            assert!(
                SOD.compile(OrgId::one(), 1, policies).is_err(),
                "{policies}"
            );
        }
    }
}
