use console_kernel_core::KernelError;

use super::AUTHORING_ACTIONS;

// ---------------------------------------------------------------------------
// No-code authoring: blocks → normalized row → generated Cedar text
// ---------------------------------------------------------------------------

/// Whether an authored policy grants or denies. `forbid` always wins in Cedar,
/// so it is the shape for tenant-isolation / legal-hold guardrails.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Effect {
    Permit,
    Forbid,
}

impl Effect {
    /// Database and canonical-wire representation of this effect.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        self.keyword()
    }

    pub(super) const fn keyword(self) -> &'static str {
        match self {
            Self::Permit => "permit",
            Self::Forbid => "forbid",
        }
    }
}

/// Comparison used by one authored condition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConditionOp {
    /// `attr == value`
    Eq,
    /// `attr != value`
    Ne,
    /// set-membership: `principal.<set>.contains("value")`
    Contains,
}

/// The right-hand side of a condition.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "value")]
pub enum ConditionValue {
    /// A string literal, rendered quoted (`"..."`).
    Literal(String),
    /// A reference to a subject attribute, rendered `principal.<attr>` unquoted.
    /// Only whitelisted subject attrs are allowed (see [`SUBJECT_ATTRS`]).
    SubjectAttr(String),
    /// A boolean literal, rendered `true`/`false`.
    Bool(bool),
}

/// One AND-ed condition on the policy's `when` clause. `attr` is always a
/// `resource.<attr>` (or a `principal.<set>` for [`ConditionOp::Contains`]).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Condition {
    /// Left-hand attribute name (bare, e.g. `owner`, `resource_type`, `roles`).
    pub attr: String,
    pub op: ConditionOp,
    pub value: ConditionValue,
}

/// The no-code authoring blocks the UI builds. Deliberately narrow: an authored
/// policy is one effect, one action, one resource-type, and a set of AND-ed
/// conditions. `OR`/nested groups are a future widening (§5d grammar note).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct NoCodeBlocks {
    pub effect: Effect,
    /// Must be one of the [`AUTHORING_SCHEMA`] actions or validation fails closed.
    ///
    /// [`AUTHORING_SCHEMA`]: super::AUTHORING_SCHEMA
    pub action: String,
    pub resource_type: String,
    #[serde(default)]
    pub conditions: Vec<Condition>,
}

/// Whitelisted resource attributes that may appear on the left of a condition.
pub(super) const RESOURCE_ATTRS: &[&str] = &["resource_type", "owner", "branch", "legal_hold"];
/// The subset of [`RESOURCE_ATTRS`] declared optional (`?`) in the schema. Cedar
/// strict validation forbids reading an optional attribute without a `has` guard,
/// so a condition on one of these emits `resource has <attr> && …`.
pub(super) const OPTIONAL_RESOURCE_ATTRS: &[&str] = &["owner", "branch", "legal_hold"];

/// A property an object type declares, admitted into policies scoped to that type.
///
/// The execution layer has always supported this: `residual::lower` binds the
/// attribute key as a value and reads the instance's `attributes` JSONB, with no
/// whitelist. Only the authoring validator was still limited to the four generic
/// `Resource` attributes, so a policy over a declared property could be *executed*
/// but never *authored* — and an enforced row carrying one failed the read path
/// closed. Widening happens through the schema, not around it: each declared
/// property is spliced into the `Resource` entity so Cedar strict validation still
/// proves every attribute read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeclaredAttr {
    pub key: String,
    /// `true` renders Cedar `Bool`, `false` renders `String`.
    pub boolean: bool,
}

impl DeclaredAttr {
    pub(super) const fn cedar_type(&self) -> &'static str {
        if self.boolean { "Bool" } else { "String" }
    }
}

pub(super) fn declares(declared: &[DeclaredAttr], attr: &str) -> bool {
    declared.iter().any(|candidate| candidate.key == attr)
}
/// Whitelisted subject attributes referenceable on the right of a condition or
/// as the set for `contains`.
pub(super) const SUBJECT_ATTRS: &[&str] = &["org", "user_id", "roles", "clearance_keys"];

pub(super) fn is_ident(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// A resource-type stable key, mirroring the object-type CHECK
/// `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$` (`0152:20`, `0165:94`).
///
/// Dots matter: an object type may legitimately be keyed `hr.employee`, and the
/// runtime matches an attached policy by `block.resource_type == stable_key`.
/// Refusing a dot here would make every dotted object type permanently
/// un-policyable and therefore — once the single-instance reads are gated —
/// permanently invisible on every read path. That is a hole, not a fix.
///
/// This is not a widening of the injection boundary: `resource_type` is emitted
/// only through [`quote`] as a JSON-escaped string literal, where a dot is inert.
/// On every non-dot axis this predicate is strictly TIGHTER than [`is_ident`],
/// which it is spelled in terms of so the two cannot drift: each segment is an
/// ident that additionally has to START with a letter, so `1abc`, `_x` and `123`
/// were accepted before and are refused now. An empty segment — `""`, `.a`,
/// `a.`, `a..b` — is refused by `is_ident`.
///
/// [`quote`]: super::quote
pub(super) fn is_stable_key(s: &str) -> bool {
    s.split('.')
        .all(|segment| is_ident(segment) && segment.starts_with(|c: char| c.is_ascii_lowercase()))
}

/// Validate no-code blocks against the closed attribute/action whitelist and the
/// resource-type stable-key shape. This is the boundary that keeps generated
/// Cedar text un-injectable: every emitted token comes from a whitelist or a
/// shape-checked literal, never raw pass-through.
pub(super) fn check_blocks_with(
    blocks: &NoCodeBlocks,
    declared: &[DeclaredAttr],
) -> Result<(), KernelError> {
    for attr in declared {
        if !is_ident(&attr.key) {
            return Err(KernelError::validation(format!(
                "declared property {:?} is not a [a-z0-9_] key",
                attr.key
            )));
        }
    }
    if !AUTHORING_ACTIONS.contains(&blocks.action.as_str()) {
        return Err(KernelError::validation(format!(
            "unknown authoring action {:?}: expected one of {AUTHORING_ACTIONS:?}",
            blocks.action
        )));
    }
    if !is_stable_key(&blocks.resource_type) {
        return Err(KernelError::validation(
            "resource_type must be a dot-separated [a-z][a-z0-9_]* stable key",
        ));
    }
    for cond in &blocks.conditions {
        match cond.op {
            ConditionOp::Contains => {
                if !SUBJECT_ATTRS.contains(&cond.attr.as_str()) {
                    return Err(KernelError::validation(format!(
                        "`contains` requires a subject set attribute, got {:?}",
                        cond.attr
                    )));
                }
                if !matches!(cond.value, ConditionValue::Literal(_)) {
                    return Err(KernelError::validation(
                        "`contains` requires a string-literal value",
                    ));
                }
            }
            ConditionOp::Eq | ConditionOp::Ne => {
                if !RESOURCE_ATTRS.contains(&cond.attr.as_str()) && !declares(declared, &cond.attr)
                {
                    return Err(KernelError::validation(format!(
                        "condition attribute {:?} is neither a whitelisted resource attribute \
                         nor a property declared by this object type",
                        cond.attr
                    )));
                }
            }
        }
        if let ConditionValue::SubjectAttr(attr) = &cond.value
            && !SUBJECT_ATTRS.contains(&attr.as_str())
        {
            return Err(KernelError::validation(format!(
                "subject-attr reference {attr:?} is not whitelisted"
            )));
        }
        // Literals may contain arbitrary text; they are always emitted through
        // Cedar's JSON string escaping below, never concatenated raw.
    }
    Ok(())
}
