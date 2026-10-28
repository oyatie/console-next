//! Real Cedar bundle compilation + evaluation for the Cedar/PBAC boundary.
//!
//! This module compiles schema-validated Cedar bundles from the legacy
//! permission matrix (one bundle per enrolled [`Feature`]) and evaluates an
//! [`AuthorizationRequest`] into a real [`CedarEvaluation`]. Most production
//! paths still use the legacy boundary or shadow lane; selected
//! high-sensitivity surfaces (for example the CEO/top-clearance covert audit
//! stream) can opt into Cedar-only enforcement with server-loaded facts.
//!
//! Two safety properties are load-bearing:
//!  * **Fail-closed compile.** [`compile_bundle`] rejects the bundle on ANY
//!    strict-validation error OR warning, so a schema/policy that does not
//!    typecheck can never activate.
//!  * **Nothing escapes evaluation.** [`evaluate`] wraps the whole Cedar call in
//!    a `Result` plus [`std::panic::catch_unwind`]; any error, parse failure, or
//!    Cedar panic becomes a recorded [`CedarEvaluation::Error`] rather than a
//!    thrown exception that could alter a live outcome.

use std::collections::{HashMap, HashSet};
use std::panic::AssertUnwindSafe;
use std::str::FromStr;

use cedar_policy::{
    Authorizer, Context, Decision, Entities, Entity, EntityId, EntityTypeName, EntityUid,
    PolicySet, Request, RestrictedExpression, Schema, ValidationMode, Validator,
};
use console_kernel_core::{KernelError, OrgId};
use sha2::{Digest, Sha256};

#[path = "audit_stream_policy.rs"]
mod audit_stream_policy;
use super::{AuthorizationRequest, CedarEvaluation, CompiledBundleCacheKey};
use crate::{Feature, PermissionLevel, Role, permission_for};
pub use audit_stream_policy::generate_audit_stream_policies;

#[path = "engine_schema.rs"]
mod schema;
use schema::CONTEXT_SCHEMA;
pub use schema::{
    AUDIT_STREAM_SCHEMA, AUDIT_STREAM_SCHEMA_VERSION, CEDAR_LANGUAGE_VERSION, CEDAR_SDK_VERSION,
    CEO_COVERT_AUDIT_CLEARANCE_KEY, CEO_COVERT_AUDIT_STREAM_KEY, ROLE_MANAGE_SCHEMA,
    ROLE_MANAGE_SCHEMA_VERSION, SHARED_ENTITY_SCHEMA,
};

/// Parsed + strict-validated Cedar bundle material for one enrolled action.
///
/// This is bundle identity + compiled artifacts, not a decision cache. The key
/// is the only thing the coexistence map compares; `schema`/`policies` are the
/// inputs [`evaluate`] runs the authorizer against.
#[derive(Debug, Clone)]
pub struct CompiledBundle {
    pub key: CompiledBundleCacheKey,
    schema: Schema,
    policies: PolicySet,
}

/// Generate the Cedar policy text for `feature` directly from the legacy
/// permission matrix.
///
/// One `permit` is emitted per role whose matrix cell for `feature` is
/// [`PermissionLevel::Allow`] (`Role::ALL` order). Generating from
/// [`permission_for`] — rather than hand-authoring a parallel ruleset — keeps
/// Cedar and the legacy matrix provably equivalent. For [`Feature::RoleManage`]
/// this is exactly one rule (SUPER_ADMIN).
#[must_use]
pub fn generate_policies(feature: Feature) -> String {
    let action = feature.as_str();
    let mut policies = String::new();
    for role in Role::ALL {
        if permission_for(role, feature) == PermissionLevel::Allow {
            policies.push_str(&format!(
                "permit(\n  principal,\n  action == Action::\"{action}\",\n  resource\n)\nwhen {{ principal.roles.contains(\"{role}\") }};\n",
                role = role.as_str()
            ));
        }
    }
    policies
}

/// Compile the RoleManage pilot bundle for `org_id` at `policy_version`.
///
/// Fail-closed: returns `Err` on any parse error or on ANY strict-validation
/// error OR warning (see [`compile_bundle_from_sources`]).
///
/// Panic-safe like [`evaluate`]: a Cedar-SDK panic during schema/policy compile or
/// strict validation is caught and recorded as an `Err`, never unwound out of the
/// shadow lane. This upholds the ADR-0021 invariant that the shadow lane can never
/// alter (or abort) a live authorization outcome.
pub fn compile_bundle(org_id: OrgId, policy_version: u64) -> Result<CompiledBundle, KernelError> {
    match std::panic::catch_unwind(AssertUnwindSafe(|| {
        compile_bundle_inner(org_id, policy_version)
    })) {
        Ok(result) => result,
        Err(_) => Err(KernelError::validation(
            "cedar bundle compilation panicked".to_owned(),
        )),
    }
}

/// Cedar schema for an arbitrary enrolled `feature`, mirroring
/// [`ROLE_MANAGE_SCHEMA`] but with the declared action id bound to
/// [`Feature::as_str`]. The server-derived `Subject`/`Resource`/context shape is
/// identical; only the action name changes, so an enrolled feature addresses
/// exactly its own Cedar action and cannot match another feature's permits.
#[must_use]
pub fn feature_schema(feature: Feature) -> String {
    format!(
        "{SHARED_ENTITY_SCHEMA}\n\naction \"{action}\" appliesTo {{\n  principal: [Subject],\n  resource: [Resource],\n  {CONTEXT_SCHEMA}\n}};\n",
        action = feature.as_str()
    )
}

/// Schema identity for a per-feature bundle, distinct per feature so cache keys
/// never collide across features/actions.
#[must_use]
pub fn feature_schema_version(feature: Feature) -> String {
    format!("2026-10-feature-{}-v2", feature.as_str())
}

/// Compile a strict-validated Cedar bundle for an arbitrary enrolled `feature`,
/// with `permit`s generated from the legacy permission matrix (so Cedar and the
/// matrix stay provably equivalent). Panic-safe and fail-closed exactly like
/// [`compile_bundle`]; this is the enrollment-wave-2 generalization of the
/// RoleManage pilot to the workflow decide-path and object-resolve features.
pub fn compile_bundle_for_feature(
    org_id: OrgId,
    policy_version: u64,
    feature: Feature,
) -> Result<CompiledBundle, KernelError> {
    match std::panic::catch_unwind(AssertUnwindSafe(|| {
        compile_bundle_from_sources(
            org_id,
            policy_version,
            &feature_schema_version(feature),
            &feature_schema(feature),
            &generate_policies(feature),
        )
    })) {
        Ok(result) => result,
        Err(_) => Err(KernelError::validation(
            "cedar feature bundle compilation panicked".to_owned(),
        )),
    }
}

/// Compile the B26b CEO/top-clearance covert audit stream bundle.
///
/// This bundle has no legacy role-matrix allow path: both stream read actions
/// require the server-loaded clearance key on the Cedar subject, the same tenant
/// org on subject/resource, and the fixed CEO covert audit stream resource id.
pub fn compile_audit_stream_bundle(
    org_id: OrgId,
    policy_version: u64,
) -> Result<CompiledBundle, KernelError> {
    match std::panic::catch_unwind(AssertUnwindSafe(|| {
        compile_audit_stream_bundle_inner(org_id, policy_version)
    })) {
        Ok(result) => result,
        Err(_) => Err(KernelError::validation(
            "cedar audit-stream bundle compilation panicked".to_owned(),
        )),
    }
}

fn compile_audit_stream_bundle_inner(
    org_id: OrgId,
    policy_version: u64,
) -> Result<CompiledBundle, KernelError> {
    compile_bundle_from_sources(
        org_id,
        policy_version,
        AUDIT_STREAM_SCHEMA_VERSION,
        AUDIT_STREAM_SCHEMA,
        &generate_audit_stream_policies(),
    )
}

fn compile_bundle_inner(org_id: OrgId, policy_version: u64) -> Result<CompiledBundle, KernelError> {
    compile_bundle_from_sources(
        org_id,
        policy_version,
        ROLE_MANAGE_SCHEMA_VERSION,
        ROLE_MANAGE_SCHEMA,
        &generate_policies(Feature::RoleManage),
    )
}

/// Parse `schema_src` + `policy_src`, run strict validation, and build the
/// compiled bundle with its cache key.
///
/// Any parse failure, or ANY strict-validation error OR warning, returns `Err`
/// (the schema-backed rejection): the bundle is "not activated" and callers
/// treat a missing bundle as `BundleUnavailable`.
pub fn compile_bundle_from_sources(
    org_id: OrgId,
    policy_version: u64,
    schema_version: &str,
    schema_src: &str,
    policy_src: &str,
) -> Result<CompiledBundle, KernelError> {
    crate::cedar_stack::with_cedar_stack(|| {
        let schema = Schema::from_str(schema_src)
            .map_err(|err| KernelError::validation(format!("cedar schema parse failed: {err}")))?;
        let policies = PolicySet::from_str(policy_src)
            .map_err(|err| KernelError::validation(format!("cedar policy parse failed: {err}")))?;

        let result = Validator::new(schema.clone()).validate(&policies, ValidationMode::Strict);
        if !result.validation_passed_without_warnings() {
            let detail = result
                .validation_errors()
                .map(ToString::to_string)
                .chain(result.validation_warnings().map(ToString::to_string))
                .collect::<Vec<_>>()
                .join("; ");
            return Err(KernelError::validation(format!(
                "cedar bundle failed strict validation: {detail}"
            )));
        }

        let key = CompiledBundleCacheKey::new(
            org_id,
            policy_version,
            schema_version,
            bundle_digest(schema_src, policy_src),
            CEDAR_SDK_VERSION,
            CEDAR_LANGUAGE_VERSION,
        )?;

        Ok(CompiledBundle {
            key,
            schema,
            policies,
        })
    })
}

/// Evaluate `request` against a compiled `bundle` into a real Cedar decision.
///
/// Nothing escapes: any construction/parse error becomes
/// [`CedarEvaluation::Error`], and a Cedar panic is caught and recorded the same
/// way so a Cedar bug can never propagate as an exception into a live path.
#[must_use]
pub fn evaluate(request: &AuthorizationRequest, bundle: &CompiledBundle) -> CedarEvaluation {
    super::facts::evaluate_with_context(request, bundle, Vec::new())
}

#[path = "engine_entities.rs"]
mod entity_evaluation;
pub use entity_evaluation::evaluate_entities;

/// The Cedar call itself; `facts::evaluate_with_context` wraps it panic-safe.
pub(super) fn evaluate_inner(
    request: &AuthorizationRequest,
    bundle: &CompiledBundle,
    facts: Vec<(String, RestrictedExpression)>,
) -> Result<CedarEvaluation, String> {
    let principal = &request.subject.principal;

    // Subject entity — server-derived roles + freshness + clearance only.
    let subject_uid = entity_uid("Subject", &principal.user_id.to_string())?;
    let roles = principal
        .roles
        .iter()
        .map(|role| RestrictedExpression::new_string(role.as_str().to_owned()));
    let subject_version = i64::try_from(request.subject.freshness.subject_version)
        .map_err(|_| "subject_version exceeds i64 range".to_owned())?;
    let subject_attrs = HashMap::from([
        (
            "org".to_owned(),
            RestrictedExpression::new_string(principal.org_id.to_string()),
        ),
        ("roles".to_owned(), RestrictedExpression::new_set(roles)),
        (
            "is_tenant_ops".to_owned(),
            RestrictedExpression::new_bool(principal.is_tenant_ops),
        ),
        (
            "subject_version".to_owned(),
            RestrictedExpression::new_long(subject_version),
        ),
        (
            "clearance_keys".to_owned(),
            RestrictedExpression::new_set(
                request
                    .subject
                    .clearance_keys
                    .iter()
                    .cloned()
                    .map(RestrictedExpression::new_string),
            ),
        ),
    ]);
    let subject = Entity::new(subject_uid.clone(), subject_attrs, HashSet::new())
        .map_err(|err| format!("cedar subject entity failed: {err}"))?;

    // Resource entity — from the server-loaded resource scope.
    let resource = &request.resource;
    let resource_eid = resource
        .resource_id
        .clone()
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| resource.resource_type.clone());
    let resource_uid = entity_uid("Resource", &resource_eid)?;
    let mut resource_attrs = HashMap::from([
        (
            "org".to_owned(),
            RestrictedExpression::new_string(resource.org_id.to_string()),
        ),
        (
            "resource_type".to_owned(),
            RestrictedExpression::new_string(resource.resource_type.clone()),
        ),
    ]);
    if let Some(resource_id) = &resource.resource_id {
        resource_attrs.insert(
            "resource_id".to_owned(),
            RestrictedExpression::new_string(resource_id.clone()),
        );
    }
    if let Some(branch_id) = resource.branch_id {
        resource_attrs.insert(
            "branch".to_owned(),
            RestrictedExpression::new_string(branch_id.to_string()),
        );
    }
    let resource_entity = Entity::new(resource_uid.clone(), resource_attrs, HashSet::new())
        .map_err(|err| format!("cedar resource entity failed: {err}"))?;

    // Action id == Feature::as_str; an unenrolled feature is not a declared
    // schema action, so request construction fails closed below.
    let action_uid = entity_uid("Action", request.action.feature().as_str())?;

    // Context — required server-computed facts (BW-28), then the optional
    // envelope. A missing, mistyped or extra fact fails request validation.
    let mut context_pairs = facts;
    if let Some(purpose) = &request.context.purpose {
        context_pairs.push((
            "purpose".to_owned(),
            RestrictedExpression::new_string(purpose.clone()),
        ));
    }
    if let Some(channel) = &request.context.channel {
        context_pairs.push((
            "channel".to_owned(),
            RestrictedExpression::new_string(channel.clone()),
        ));
    }
    let context =
        Context::from_pairs(context_pairs).map_err(|err| format!("cedar context failed: {err}"))?;

    let entities = Entities::from_entities([subject, resource_entity], Some(&bundle.schema))
        .map_err(|err| format!("cedar entities failed: {err}"))?;
    let cedar_request = Request::new(
        subject_uid,
        action_uid,
        resource_uid,
        context,
        Some(&bundle.schema),
    )
    .map_err(|err| format!("cedar request failed: {err}"))?;

    let response = Authorizer::new().is_authorized(&cedar_request, &bundle.policies, &entities);
    // BW-28 fail-closed: Cedar SKIPS an erroring policy, so a skipped `forbid`
    // would yield Allow. Any evaluation error is an Error, whatever the decision.
    let errors: Vec<String> = response
        .diagnostics()
        .errors()
        .map(ToString::to_string)
        .collect();
    if !errors.is_empty() {
        return Err(format!("cedar evaluation errors: {}", errors.join("; ")));
    }
    Ok(match response.decision() {
        Decision::Allow => CedarEvaluation::Allow {
            bundle_key: bundle.key.clone(),
        },
        Decision::Deny => CedarEvaluation::Deny {
            bundle_key: bundle.key.clone(),
            reason: "cedar denied: no matching permit".to_owned(),
        },
    })
}

fn entity_uid(type_name: &str, id: &str) -> Result<EntityUid, String> {
    let parsed = EntityTypeName::from_str(type_name)
        .map_err(|err| format!("cedar entity type '{type_name}' invalid: {err}"))?;
    Ok(EntityUid::from_type_name_and_id(parsed, EntityId::new(id)))
}

/// Deterministic bundle digest: `hex(sha256(schema_src ‖ policy_src))`.
fn bundle_digest(schema_src: &str, policy_src: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(schema_src.as_bytes());
    hasher.update(policy_src.as_bytes());
    hex::encode(hasher.finalize())
}

#[cfg(test)]
#[path = "engine_tests.rs"]
mod tests;
