//! This face's slice of the published OpenAPI contract.
//!
//! Bodies live as YAML under `openapi/` and are pulled in via `include_str!`.
//! `console_contracts` re-indents them; composition rejects duplicate keys.

use console_contracts::{Fragment, NamedYaml, Operation, PathItem};

/// This face's contribution to the composed OpenAPI document.
pub const OPENAPI_FRAGMENT: Fragment = Fragment {
    source: "console-onboarding-rest",
    paths: PATHS,
    schemas: SCHEMAS,
    parameters: &[],
    responses: &[],
    security_schemes: &[],
    external_schemas: EXTERNAL_SCHEMAS,
};

const EXTERNAL_SCHEMAS: &[&str] = &[
    "ActorKind",
    "AuditLastChange",
    "ErrorBody",
    "FieldError",
    "SetupChecklist",
    "SetupStep",
    "SetupStepState",
    "Uuid",
];

const PATHS: &[PathItem] = &[
    PathItem {
        path: "/api/v1/onboarding/modules",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__onboarding__modules.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/onboarding/checklist",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__onboarding__checklist.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/onboarding/go-live",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__onboarding__go-live.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/onboarding/go-live/preview",
        operations: &[Operation {
            method: "get",
            body: include_str!("../openapi/paths/api__v1__onboarding__go-live__preview.get.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/onboarding/steps/{step}/skip",
        operations: &[Operation {
            method: "post",
            body: include_str!("../openapi/paths/api__v1__onboarding__steps__step__skip.post.yaml"),
        }],
    },
    PathItem {
        path: "/api/v1/onboarding/terms",
        operations: &[
            Operation {
                method: "get",
                body: include_str!("../openapi/paths/api__v1__onboarding__terms.get.yaml"),
            },
            Operation {
                method: "post",
                body: include_str!("../openapi/paths/api__v1__onboarding__terms.post.yaml"),
            },
        ],
    },
];

const SCHEMAS: &[NamedYaml] = &[
    NamedYaml {
        name: "OnboardingModules",
        body: include_str!("../openapi/schemas/OnboardingModules.yaml"),
    },
    NamedYaml {
        name: "GoLivePreview",
        body: include_str!("../openapi/schemas/GoLivePreview.yaml"),
    },
    NamedYaml {
        name: "GoLivePreviewItem",
        body: include_str!("../openapi/schemas/GoLivePreviewItem.yaml"),
    },
    NamedYaml {
        name: "GoLiveRequest",
        body: include_str!("../openapi/schemas/GoLiveRequest.yaml"),
    },
    NamedYaml {
        name: "GoLiveResult",
        body: include_str!("../openapi/schemas/GoLiveResult.yaml"),
    },
    NamedYaml {
        name: "SetupFacts",
        body: include_str!("../openapi/schemas/SetupFacts.yaml"),
    },
    NamedYaml {
        name: "TermsAcceptanceRequest",
        body: include_str!("../openapi/schemas/TermsAcceptanceRequest.yaml"),
    },
    NamedYaml {
        name: "TermsDocument",
        body: include_str!("../openapi/schemas/TermsDocument.yaml"),
    },
];
