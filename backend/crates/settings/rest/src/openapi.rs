//! This face's slice of the published OpenAPI contract.
//!
//! Bodies live as YAML under `openapi/` and are pulled in via `include_str!`.
//! `console_contracts` re-indents them; composition rejects duplicate keys.

use console_contracts::{Fragment, NamedYaml, Operation, PathItem};

/// This face's contribution to the composed OpenAPI document.
pub const OPENAPI_FRAGMENT: Fragment = Fragment {
    source: "console-settings-rest",
    paths: PATHS,
    schemas: SCHEMAS,
    parameters: &[],
    responses: &[],
    security_schemes: &[],
    external_schemas: EXTERNAL_SCHEMAS,
};

const EXTERNAL_SCHEMAS: &[&str] = &["ActorKind", "Timestamp", "Uuid"];

const PATHS: &[PathItem] = &[
    PathItem {
        path: "/api/v1/reason-codes",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__reason-codes.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!("../openapi/paths/api__v1__reason-codes.post.yaml"),
            },
        ],
    },
    PathItem {
        path: "/api/v1/reason-codes/stats",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__reason-codes__stats.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/reason-codes/{domain}/{code}",
        operations: &[Operation {
            method: "patch",
            body: include_str!("../openapi/paths/api__v1__reason-codes__domain__code.patch.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/settings",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__settings.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/settings/{key}",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__settings__key.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/settings/{key}/history",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__settings__key__history.get.yaml"),
        }],
    },
];

const SCHEMAS: &[NamedYaml] = &[
    NamedYaml {
        name: "ReasonCatalogEntry",
        body: include_str!("../openapi/schemas/ReasonCatalogEntry.yaml"),
    },
    NamedYaml {
        name: "ReasonCode",
        body: include_str!("../openapi/schemas/ReasonCode.yaml"),
    },
    NamedYaml {
        name: "ReasonCodeAddRequest",
        body: include_str!("../openapi/schemas/ReasonCodeAddRequest.yaml"),
    },
    NamedYaml {
        name: "ReasonCodeSourceStats",
        body: include_str!("../openapi/schemas/ReasonCodeSourceStats.yaml"),
    },
    NamedYaml {
        name: "ReasonCodeUpdateRequest",
        body: include_str!("../openapi/schemas/ReasonCodeUpdateRequest.yaml"),
    },
    NamedYaml {
        name: "SettingChange",
        body: include_str!("../openapi/schemas/SettingChange.yaml"),
    },
    NamedYaml {
        name: "SettingChangePlan",
        body: include_str!("../openapi/schemas/SettingChangePlan.yaml"),
    },
    NamedYaml {
        name: "SettingChangeRequest",
        body: include_str!("../openapi/schemas/SettingChangeRequest.yaml"),
    },
    NamedYaml {
        name: "SettingDirection",
        body: include_str!("../openapi/schemas/SettingDirection.yaml"),
    },
    NamedYaml {
        name: "SettingEntry",
        body: include_str!("../openapi/schemas/SettingEntry.yaml"),
    },
    NamedYaml {
        name: "SettingOverrideRecord",
        body: include_str!("../openapi/schemas/SettingOverrideRecord.yaml"),
    },
    NamedYaml {
        name: "SettingValue",
        body: include_str!("../openapi/schemas/SettingValue.yaml"),
    },
    NamedYaml {
        name: "SettingVersionId",
        body: include_str!("../openapi/schemas/SettingVersionId.yaml"),
    },
    NamedYaml {
        name: "TenantReasonCode",
        body: include_str!("../openapi/schemas/TenantReasonCode.yaml"),
    },
];
