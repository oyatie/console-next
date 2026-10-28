//! Cedar-only SoD actions, one file per action (`actions/<action>.rs`, agent
//! rules §2.6). Each file declares one [`ActionSchema`]: its required facts and
//! its own `permit`/`forbid` rules. A lane adds its `mod` line and one registry
//! line below; INTEG merges them. The `action_schema` tests gate every entry.

pub mod certificates;
pub mod change_request_decide;
pub mod exception_decide;
pub mod legal_entity_manage;
// --- lane: BE-EMP-UI ---
pub mod job_title_manage;
// --- lane: CRUD ---
pub mod org_change_cancel;
pub mod org_change_draft;
pub mod org_change_step_decide;
pub mod org_unit_manage;
// --- lane: F7 ---
pub mod reason_code_manage;
pub mod settings_manage;
pub mod support_session;

use super::action_schema::ActionSchema;

/// Every enrolled per-action schema (BW-28; decisions D0.1 §3).
pub const ACTION_SCHEMAS: &[ActionSchema] = &[
    exception_decide::SCHEMA,
    legal_entity_manage::SCHEMA,
    change_request_decide::SCHEMA,
    job_title_manage::SCHEMA,
    org_unit_manage::SCHEMA,
    settings_manage::SCHEMA,
    reason_code_manage::SCHEMA,
];

// Self-contained single-action bundles (`ActionBundle`) for actions whose
// principal/resource shape is not a `Feature` (tenant_go_live): strict
// validation, every fact required, any evaluation error denies.
pub mod tenant_go_live;
// --- lane: EMP-RECORD ---
pub mod employee_pii;
pub mod employee_restricted_record;
// --- lane: UX-R2 GUARDS ---
pub mod account_link;
pub mod own_record;
// --- lane: CX-upstream-ports ---
pub mod independent_people;
pub mod platform_listing;
// --- lane: CL-second-person ---
pub mod grant_notice;
pub mod period_unlock;
pub mod period_unlock_decide;
// --- lane: LC-B3 ---
pub mod lifecycle_item;

use std::collections::HashSet;
use std::str::FromStr;

use cedar_policy::{
    Authorizer, Context, Decision, Entities, Entity, EntityId, EntityTypeName, EntityUid,
    PolicySet, Request, RestrictedExpression, Schema, ValidationMode, Validator,
};

/// Annotations on the policies that decided this response, in stable order.
pub(super) fn deciding_reasons(
    policies: &PolicySet,
    response: &cedar_policy::Response,
) -> Vec<String> {
    let mut reasons: Vec<_> = response
        .diagnostics()
        .reason()
        .filter_map(|id| policies.policy(id)?.annotation("reason").map(str::to_owned))
        .collect();
    reasons.sort();
    reasons
}

/// One server-computed fact in a decision context.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fact {
    Bool(bool),
    Long(i64),
    Str(String),
}

/// A compiled single-action bundle.
#[derive(Debug)]
pub struct ActionBundle {
    schema: Schema,
    policies: PolicySet,
    action: &'static str,
}

impl ActionBundle {
    /// Parse and strictly validate. Any error or warning refuses the bundle.
    ///
    /// # Errors
    /// The parse or validation diagnostics.
    pub fn compile(action: &'static str, schema: &str, policies: &str) -> Result<Self, String> {
        crate::cedar_stack::with_cedar_stack(|| {
            let schema = Schema::from_str(schema).map_err(|e| format!("schema: {e}"))?;
            let policies = PolicySet::from_str(policies).map_err(|e| format!("policies: {e}"))?;
            let result = Validator::new(schema.clone()).validate(&policies, ValidationMode::Strict);
            if !result.validation_passed_without_warnings() {
                let detail: Vec<String> = result
                    .validation_errors()
                    .map(ToString::to_string)
                    .chain(result.validation_warnings().map(ToString::to_string))
                    .collect();
                return Err(detail.join("; "));
            }
            Ok(Self {
                schema,
                policies,
                action,
            })
        })
    }

    /// Evaluate with a `Subject {org, roles}` principal and a `Resource {org}`.
    /// `Ok(true)` only for an Allow with no evaluation diagnostics errors.
    ///
    /// # Errors
    /// Request construction failure, or an evaluation error (fail closed).
    pub fn decide(
        &self,
        principal_id: &str,
        principal_org: &str,
        roles: &[&str],
        resource_org: &str,
        facts: &[(&str, Fact)],
    ) -> Result<bool, String> {
        self.decide_with_reasons(principal_id, principal_org, roles, resource_org, facts)
            .map(|(allowed, _)| allowed)
    }

    /// Evaluate Cedar and return only annotations on the policies that decided it.
    pub fn decide_with_reasons(
        &self,
        principal_id: &str,
        principal_org: &str,
        roles: &[&str],
        resource_org: &str,
        facts: &[(&str, Fact)],
    ) -> Result<(bool, Vec<String>), String> {
        crate::cedar_stack::with_cedar_stack(|| {
            let uid = |ty: &str, id: &str| -> Result<EntityUid, String> {
                let ty = EntityTypeName::from_str(ty).map_err(|e| e.to_string())?;
                Ok(EntityUid::from_type_name_and_id(ty, EntityId::new(id)))
            };
            let subject_uid = uid("Subject", principal_id)?;
            let resource_uid = uid("Resource", resource_org)?;
            let subject = Entity::new(
                subject_uid.clone(),
                [
                    (
                        "org".to_owned(),
                        RestrictedExpression::new_string(principal_org.to_owned()),
                    ),
                    (
                        "roles".to_owned(),
                        RestrictedExpression::new_set(
                            roles
                                .iter()
                                .map(|r| RestrictedExpression::new_string((*r).to_owned())),
                        ),
                    ),
                ]
                .into(),
                HashSet::new(),
            )
            .map_err(|e| e.to_string())?;
            let resource = Entity::new(
                resource_uid.clone(),
                [(
                    "org".to_owned(),
                    RestrictedExpression::new_string(resource_org.to_owned()),
                )]
                .into(),
                HashSet::new(),
            )
            .map_err(|e| e.to_string())?;
            let context = Context::from_pairs(facts.iter().map(|(k, v)| {
                let value = match v {
                    Fact::Bool(b) => RestrictedExpression::new_bool(*b),
                    Fact::Long(n) => RestrictedExpression::new_long(*n),
                    Fact::Str(s) => RestrictedExpression::new_string(s.clone()),
                };
                ((*k).to_owned(), value)
            }))
            .map_err(|e| e.to_string())?;
            let entities = Entities::from_entities([subject, resource], Some(&self.schema))
                .map_err(|e| e.to_string())?;
            let request = Request::new(
                subject_uid,
                uid("Action", self.action)?,
                resource_uid,
                context,
                Some(&self.schema),
            )
            .map_err(|e| e.to_string())?;
            let response = Authorizer::new().is_authorized(&request, &self.policies, &entities);
            let errors: Vec<String> = response
                .diagnostics()
                .errors()
                .map(ToString::to_string)
                .collect();
            if !errors.is_empty() {
                return Err(errors.join("; "));
            }
            let reasons = deciding_reasons(&self.policies, &response);
            Ok((response.decision() == Decision::Allow, reasons))
        })
    }
}

// --- lane: CX-ideal-ledger ---
pub mod command_outcome;

pub mod company_domain_request;
pub mod import_rollback;
pub mod ops_recovery_decide;
pub mod support_reference;

pub mod tenant_erase;
