use console_kernel_core::OrgId;

use super::engine::compile_bundle_from_sources;
use super::{
    AUTHORING_SCHEMA_VERSION, Condition, ConditionOp, ConditionValue, DeclaredAttr, NoCodeBlocks,
    OPTIONAL_RESOURCE_ATTRS, check_blocks_with, declares, object_authoring_schema,
};

/// Escape a string literal for embedding in Cedar source. Cedar uses the same
/// escapes as JSON for the characters that matter here, so `serde_json` gives a
/// correct, injection-safe quoted literal.
pub(super) fn quote(s: &str) -> String {
    serde_json::Value::String(s.to_owned()).to_string()
}

pub(super) fn render_condition(cond: &Condition, declared: &[DeclaredAttr]) -> String {
    match cond.op {
        ConditionOp::Contains => {
            // check_blocks rejects a non-literal `contains`; if generation runs on
            // already-invalid blocks (so the draft still gets storable, non-empty
            // text), emit a deliberately-mismatched literal — the draft's
            // validation_status is `invalid` regardless, so it can never submit.
            let lit = match &cond.value {
                ConditionValue::Literal(lit) => lit.clone(),
                ConditionValue::SubjectAttr(attr) => attr.clone(),
                ConditionValue::Bool(b) => b.to_string(),
            };
            format!("principal.{}.contains({})", cond.attr, quote(&lit))
        }
        ConditionOp::Eq | ConditionOp::Ne => {
            let op = if cond.op == ConditionOp::Eq {
                "=="
            } else {
                "!="
            };
            let rhs = match &cond.value {
                ConditionValue::Literal(lit) => quote(lit),
                ConditionValue::SubjectAttr(attr) => format!("principal.{attr}"),
                ConditionValue::Bool(b) => b.to_string(),
            };
            // Guard optional attrs so Cedar strict validation can prove the read
            // is safe; an absent attr makes the whole `when` false (fail-closed).
            if OPTIONAL_RESOURCE_ATTRS.contains(&cond.attr.as_str())
                || declares(declared, &cond.attr)
            {
                format!(
                    "resource has {attr} && resource.{attr} {op} {rhs}",
                    attr = cond.attr
                )
            } else {
                format!("resource.{} {op} {rhs}", cond.attr)
            }
        }
    }
}

/// Generate the real Cedar policy text for `blocks`.
///
/// The `resource_type` guard is always emitted so a policy only applies to its
/// authored object type; authored conditions are AND-ed after it.
#[must_use]
pub fn generate_cedar_text(blocks: &NoCodeBlocks) -> String {
    generate_cedar_text_with(blocks, &[])
}

/// [`generate_cedar_text`] for a policy scoped to an object type that declares
/// `declared`; those properties render with a `has` guard, like the optional
/// generic attributes.
#[must_use]
pub fn generate_cedar_text_with(blocks: &NoCodeBlocks, declared: &[DeclaredAttr]) -> String {
    let mut clauses = vec![format!(
        "resource.resource_type == {}",
        quote(&blocks.resource_type)
    )];
    clauses.extend(
        blocks
            .conditions
            .iter()
            .map(|cond| render_condition(cond, declared)),
    );
    format!(
        "{}(\n  principal,\n  action == Action::{},\n  resource\n)\nwhen {{ {} }};\n",
        blocks.effect.keyword(),
        quote(&blocks.action),
        clauses.join(" && ")
    )
}

/// Canonical, order-stable JSON projection of the blocks — the `normalized_row`
/// persisted alongside the draft. Deliberately NOT the raw `blocks` JSON so the
/// stored row is stable regardless of client key ordering.
#[must_use]
pub fn normalize(blocks: &NoCodeBlocks) -> serde_json::Value {
    serde_json::json!({
        "effect": blocks.effect,
        "action": blocks.action,
        "resource_type": blocks.resource_type,
        "conditions": blocks.conditions,
    })
}

/// Result of validating a draft's generated policy against [`AUTHORING_SCHEMA`].
///
/// [`AUTHORING_SCHEMA`]: super::AUTHORING_SCHEMA
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DraftValidation {
    pub generated_policy_text: String,
    pub normalized_row: serde_json::Value,
    pub valid: bool,
    pub errors: Vec<String>,
}

/// Normalize + generate + strict-validate no-code blocks in one call.
///
/// Reuses [`engine::compile_bundle_from_sources`], so a draft is `valid` iff the
/// generated policy parses AND passes Cedar strict validation with zero warnings
/// — the same fail-closed bar the shadow lane uses. Malformed blocks (unknown
/// action, non-whitelisted attr) short-circuit to `invalid` before Cedar runs.
///
/// [`engine::compile_bundle_from_sources`]: super::engine::compile_bundle_from_sources
#[must_use]
pub fn validate_blocks(org_id: OrgId, blocks: &NoCodeBlocks) -> DraftValidation {
    validate_blocks_with(org_id, blocks, &[])
}

/// [`validate_blocks`] for a policy scoped to an object type, admitting that
/// type's declared properties in addition to the generic `Resource` attributes.
#[must_use]
pub fn validate_blocks_with(
    org_id: OrgId,
    blocks: &NoCodeBlocks,
    declared: &[DeclaredAttr],
) -> DraftValidation {
    let normalized_row = normalize(blocks);
    // Always generate non-empty text so the draft row is storable (the drafts
    // table CHECKs char_length > 0); `valid` is the authoritative signal.
    let generated_policy_text = generate_cedar_text_with(blocks, declared);
    if let Err(err) = check_blocks_with(blocks, declared) {
        return DraftValidation {
            generated_policy_text,
            normalized_row,
            valid: false,
            errors: vec![err.message],
        };
    }
    match compile_bundle_from_sources(
        org_id,
        1,
        AUTHORING_SCHEMA_VERSION,
        &object_authoring_schema(declared),
        &generated_policy_text,
    ) {
        Ok(_) => DraftValidation {
            generated_policy_text,
            normalized_row,
            valid: true,
            errors: Vec::new(),
        },
        Err(err) => DraftValidation {
            generated_policy_text,
            normalized_row,
            valid: false,
            errors: vec![err.message],
        },
    }
}
