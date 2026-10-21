use super::{DeclaredAttr, quote};

/// Schema identity for the generic ontology object/property authoring bundle.
/// Bump when [`AUTHORING_SCHEMA`] changes so validated digests never collide.
pub const AUTHORING_SCHEMA_VERSION: &str = "2026-07-ontology-authoring-v1";

/// Cedar schema every authored object/property policy validates against.
///
/// Entities carry only SERVER-loaded material (a UI/JWT projection can't
/// fabricate `roles`/`clearance_keys`/`owner`). Actions are the fixed set the
/// ontology surfaces the authoring UI targets: `view`/`edit` are row (object)
/// policies, `read_field` is the property (field) policy. An authored policy for
/// any other action fails strict validation and is rejected fail-closed.
///
/// `` fixed 3-action schema — object/property policies are the only
/// authoring surface today. Declare more actions here (zero code change) when a
/// real policy needs them.
pub const AUTHORING_SCHEMA: &str = r#"entity Subject = {
  "org": String,
  "user_id": String,
  "roles": Set<String>,
  "clearance_keys": Set<String>
};

entity Resource = {
  "org": String,
  "resource_type": String,
  "resource_id"?: String,
  "owner"?: String,
  "branch"?: String,
  "legal_hold"?: Bool
};

action view appliesTo {
  principal: [Subject],
  resource: [Resource],
  context: { "purpose"?: String }
};

action edit appliesTo {
  principal: [Subject],
  resource: [Resource],
  context: { "purpose"?: String }
};

action read_field appliesTo {
  principal: [Subject],
  resource: [Resource],
  context: { "field"?: String }
};

action "console:configure" appliesTo {
  principal: [Subject],
  resource: [Resource],
  context: { "purpose"?: String }
};

action "console:deploy" appliesTo {
  principal: [Subject],
  resource: [Resource],
  context: { "purpose"?: String }
};
"#;

/// The row-visibility action for an object policy.
pub const OBJECT_POLICY_ACTION: &str = "view";
/// The field-visibility action for a property policy.
pub const PROPERTY_POLICY_ACTION: &str = "read_field";

/// The exact text declared properties are spliced after. A unit test asserts it
/// still occurs exactly once in [`AUTHORING_SCHEMA`], so editing the schema can
/// never silently disable object-scoped policies.
pub(super) const SCHEMA_SPLICE_ANCHOR: &str = "\n  \"legal_hold\"?: Bool\n};";

/// [`AUTHORING_SCHEMA`] widened with an object type's declared properties, each
/// optional so an instance missing the attribute fails the `when` closed.
pub(super) fn object_authoring_schema(declared: &[DeclaredAttr]) -> String {
    if declared.is_empty() {
        return AUTHORING_SCHEMA.to_owned();
    }
    let extra: String = declared
        .iter()
        .map(|attr| format!(",\n  {}?: {}", quote(&attr.key), attr.cedar_type()))
        .collect();
    AUTHORING_SCHEMA.replacen(
        SCHEMA_SPLICE_ANCHOR,
        &format!("\n  \"legal_hold\"?: Bool{extra}\n}};"),
        1,
    )
}

/// Actions the authoring schema declares.
// `console:configure` (internal-employee console configuration) and
// `console:deploy` (elevated / 민감정보+ clearance deployment) are console-authority
// verbs (design change-log 86). They are authorizable but carry NO seeded permit,
// so deny-by-omission denies external/candidate principals (configure) and any
// principal lacking the clearance (deploy) fail-closed until an org authors a
// scoped permit through the no-code builder.
pub(super) const AUTHORING_ACTIONS: &[&str] = &[
    "view",
    "edit",
    "read_field",
    "console:configure",
    "console:deploy",
];
