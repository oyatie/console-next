use super::RouteSource;

pub(super) const CONFIGURED_ROUTE_SOURCES: &[RouteSource] = &[
    RouteSource {
        name: "support reference app router",
        surface: "support-reference",
        source: include_str!("../../src/http/support_reference.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "attendance REST router",
        surface: "attendance",
        source: include_str!("../../../crates/attendance/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "inventory REST router",
        surface: "inventory",
        source: include_str!("../../../crates/inventory/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "dispatch REST router",
        surface: "dispatch",
        source: include_str!("../../../crates/dispatch/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "benefit REST router",
        surface: "benefit",
        source: include_str!("../../../crates/benefit/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "financial REST router",
        surface: "financial",
        source: include_str!("../../../crates/financial/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "evaluation REST router",
        surface: "evaluation",
        source: include_str!("../../../crates/evaluation/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "inspection REST router",
        surface: "inspection",
        source: include_str!("../../../crates/inspection/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "support REST router",
        surface: "support",
        source: include_str!("../../../crates/support/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "identity REST router",
        surface: "identity",
        source: include_str!("../../../crates/identity/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "compliance REST router",
        surface: "compliance",
        source: include_str!("../../../crates/compliance/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "integrity REST router",
        surface: "integrity",
        source: include_str!("../../../crates/compliance/integrity/src/rest.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "registry REST router",
        surface: "registry",
        source: include_str!("../../../crates/registry/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "HR app router",
        surface: "hr",
        source: include_str!("../../src/hr.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "Workflow Studio app router",
        surface: "workflow-studio",
        source: include_str!("../../src/workflow_studio.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "collaboration app router",
        surface: "collaboration",
        source: include_str!("../../src/collaboration.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "sales REST router",
        surface: "sales",
        source: include_str!("../../../crates/sales/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "reporting REST router",
        surface: "reporting",
        source: include_str!("../../../crates/reporting/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "workorder REST routers",
        surface: "workorder",
        source: include_str!("../../../crates/workorder/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "messenger REST router",
        surface: "messenger",
        source: include_str!("../../../crates/messenger/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "comms REST router",
        surface: "comms",
        source: include_str!("../../../crates/comms/rest/src/lib.rs"),
        // The MOX inbound webhook authenticates with a provider HMAC secret (not a
        // customer session) and is deliberately absent from the customer OpenAPI +
        // SDK clients; keep it out of the drift inventory intentionally.
        ignored_route_refs: &["MAIL_MOX_WEBHOOK_PATH"],
    },
    RouteSource {
        name: "platform REST router",
        surface: "platform",
        // The router is in lib.rs; its path constants live in routes.rs and company_domain.rs.
        source: concat!(
            include_str!("../../../crates/platform/platform-rest/src/lib.rs"),
            include_str!("../../../crates/platform/platform-rest/src/routes.rs"),
            include_str!("../../../crates/platform/platform-rest/src/company_domain.rs"),
        ),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "platform support router",
        surface: "platform",
        source: include_str!("../../../crates/platform/platform-rest/src/support.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "auth REST router",
        surface: "auth",
        source: include_str!("../../../crates/platform/auth-rest/src/lib.rs"),
        // `dev-auth` is feature-gated and intentionally absent from the production
        // OpenAPI contract/inventory.
        ignored_route_refs: &["DEV_AUTH_SESSION_PATH"],
    },
    RouteSource {
        name: "realtime router",
        surface: "realtime",
        source: include_str!("../../../crates/platform/realtime/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "ontology REST router",
        surface: "ontology",
        source: include_str!("../../../crates/ontology/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "governance REST router",
        surface: "governance",
        source: include_str!("../../../crates/governance/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "policy (cedar authoring) REST router",
        surface: "policy",
        source: include_str!("../../../crates/platform/authz-rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "evidence (docs) REST router",
        surface: "evidence",
        source: include_str!("../../../crates/docs/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "notices REST router",
        surface: "notices",
        source: include_str!("../../../crates/notices/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "finance-gl REST router",
        surface: "finance-gl",
        source: include_str!("../../../crates/finance-gl/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "payroll REST router",
        surface: "payroll",
        source: include_str!("../../../crates/payroll/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "analytics-quant REST router",
        surface: "analytics",
        source: include_str!("../../../crates/analytics-quant/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "equipment 3R REST router",
        surface: "equipment-3r",
        source: include_str!("../../../crates/equipment/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "notifications REST router",
        surface: "notifications",
        source: include_str!("../../../crates/notifications/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "orgchange REST router",
        surface: "orgchange",
        source: include_str!("../../../crates/orgchange/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "recruiting REST router",
        surface: "recruiting",
        source: include_str!("../../../crates/recruiting/rest/src/lib.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "recruiting hire app router",
        surface: "recruiting-hire",
        source: include_str!("../../src/recruiting_hire.rs"),
        ignored_route_refs: &[],
    },
    RouteSource {
        name: "HR statutory REST router",
        surface: "hr-statutory",
        source: include_str!("../../../crates/hr/rest/src/statutory.rs"),
        ignored_route_refs: &[],
    },
];
