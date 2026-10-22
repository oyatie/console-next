// SPDX-License-Identifier: LicenseRef-Proprietary
//! Server-derived Cedar entity schemas and their bundle identities.

/// Cedar SDK version pinned in `authz/Cargo.toml` (`cedar-policy = "=4.11.2"`).
/// Recorded on the compiled-bundle cache key so a Cedar upgrade re-keys bundles.
pub const CEDAR_SDK_VERSION: &str = "4.11.2";

/// Cedar policy language version implemented by [`CEDAR_SDK_VERSION`].
pub const CEDAR_LANGUAGE_VERSION: &str = "4.5";

/// Hand-picked schema identity for the RoleManage pilot bundle. Bump this string
/// whenever [`ROLE_MANAGE_SCHEMA`] changes so cache keys never collide across
/// schema shapes.
pub const ROLE_MANAGE_SCHEMA_VERSION: &str = "2026-10-role-manage-v2";

macro_rules! shared_entity_schema {
    () => {
        r#"entity Subject = {
  "org": String,
  "roles": Set<String>,
  "is_tenant_ops": Bool,
  "subject_version": Long,
  "clearance_keys": Set<String>
};

entity Resource = {
  "org": String,
  "resource_type": String,
  "resource_id"?: String,
  "branch"?: String
};"#
    };
}

/// Shared server-derived entity definitions used by every enrolled Cedar schema.
pub const SHARED_ENTITY_SCHEMA: &str = shared_entity_schema!();

pub(super) const CONTEXT_SCHEMA: &str = r#"context: {
  "purpose"?: String,
  "channel"?: String,
  "step_up"?: Bool
}"#;

/// Cedar schema (human-readable `.cedarschema` format) for the RoleManage pilot.
///
/// Entities and context carry only SERVER-derived material: a UI/JWT projection
/// can never fabricate the `roles`/`subject_version`/`clearance_keys` a permit
/// depends on. The action id is [`Feature::as_str`] (`role_manage`) so the
/// generated policy and the evaluated request address the same Cedar action.
pub const ROLE_MANAGE_SCHEMA: &str = concat!(
    shared_entity_schema!(),
    "\n\n",
    r#"action role_manage appliesTo {
  principal: [Subject],
  resource: [Resource],
  context: {
    "purpose"?: String,
    "channel"?: String,
    "step_up"?: Bool
  }
};
"#,
);

/// Schema identity for the B26b CEO/top-clearance covert audit stream bundle.
pub const AUDIT_STREAM_SCHEMA_VERSION: &str = "2026-10-ceo-covert-audit-stream-v2";

/// Tenant-owned stream id for the first covert audit stream. The public REST
/// path uses the hyphenated slug; Cedar/resource labels stay snake_case.
pub const CEO_COVERT_AUDIT_STREAM_KEY: &str = "ceo_covert_audit";

/// Clearance fact required to read the CEO/top-clearance covert stream.
pub const CEO_COVERT_AUDIT_CLEARANCE_KEY: &str = "audit.ceo_covert.read";

pub const AUDIT_STREAM_SCHEMA: &str = r#"entity Subject = {
  "org": String,
  "roles": Set<String>,
  "is_tenant_ops": Bool,
  "subject_version": Long,
  "clearance_keys": Set<String>
};

entity Resource = {
  "org": String,
  "resource_type": String,
  "resource_id": String,
  "branch"?: String
};

action audit_stream_read appliesTo {
  principal: [Subject],
  resource: [Resource],
  context: {
    "purpose"?: String,
    "channel"?: String
  }
};

action audit_stream_access_log_read appliesTo {
  principal: [Subject],
  resource: [Resource],
  context: {
    "purpose"?: String,
    "channel"?: String
  }
};
"#;
