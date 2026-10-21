//! The configured route surfaces: every mounted API path, grouped by the surface that owns it.
//! A module compiled out of this build (docs/ops/mvp-build.md) lists no surface.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConfiguredRouteSurface {
    pub name: &'static str,
    pub paths: &'static [&'static str],
}

const fn surface(name: &'static str, paths: &'static [&'static str]) -> ConfiguredRouteSurface {
    ConfiguredRouteSurface { name, paths }
}

pub const CONFIGURED_ROUTE_SURFACES: &[ConfiguredRouteSurface] = &[
    surface("public-status", crate::http::status::STATUS_ROUTE_PATHS),
    surface("requests", crate::requests::REQUEST_ROUTE_PATHS),
    surface("audit", crate::AUDIT_ROUTE_PATHS),
    #[cfg(feature = "attendance")]
    surface(
        "attendance",
        console_attendance_rest::ATTENDANCE_ROUTE_PATHS,
    ),
    #[cfg(feature = "inventory")]
    surface("inventory", console_inventory_rest::INVENTORY_ROUTE_PATHS),
    #[cfg(feature = "dispatch")]
    surface("dispatch", console_dispatch_rest::DISPATCH_ROUTE_PATHS),
    #[cfg(feature = "benefit")]
    surface("benefit", console_benefit_rest::BENEFIT_ROUTE_PATHS),
    #[cfg(feature = "consulting")]
    surface(
        "consulting",
        console_consulting_rest::CONSULTING_ROUTE_PATHS,
    ),
    #[cfg(feature = "financial")]
    surface("financial", console_financial_rest::FINANCIAL_ROUTE_PATHS),
    #[cfg(feature = "evaluation")]
    surface(
        "evaluation",
        console_evaluation_rest::EVALUATION_ROUTE_PATHS,
    ),
    #[cfg(feature = "inspection")]
    surface(
        "inspection",
        console_inspection_rest::INSPECTION_ROUTE_PATHS,
    ),
    #[cfg(feature = "support")]
    surface("support", console_support_rest::SUPPORT_ROUTE_PATHS),
    surface("identity", console_identity_rest::IDENTITY_ROUTE_PATHS),
    #[cfg(feature = "compliance")]
    surface(
        "compliance",
        console_compliance_rest::COMPLIANCE_ROUTE_PATHS,
    ),
    #[cfg(feature = "compliance")]
    surface(
        "statutory",
        console_compliance_rest::statutory::STATUTORY_ROUTE_PATHS,
    ),
    surface("settings", console_settings_rest::SETTINGS_ROUTE_PATHS),
    surface(
        "reason-codes",
        console_settings_rest::REASON_CODES_ROUTE_PATHS,
    ),
    #[cfg(feature = "integrity")]
    surface("integrity", console_integrity::INTEGRITY_ROUTE_PATHS),
    #[cfg(feature = "registry")]
    surface("registry", console_registry_rest::REGISTRY_ROUTE_PATHS),
    surface("hr", crate::hr::HR_ROUTE_PATHS),
    surface(
        "hr-statutory",
        console_hr_rest::statutory::STATUTORY_ROUTE_PATHS,
    ),
    surface("hr-records", console_hr_rest::record::RECORD_ROUTE_PATHS),
    surface("hr-profile", console_hr_rest::profile::PROFILE_ROUTE_PATHS),
    surface(
        "hr-contracts",
        console_hr_rest::contract::CONTRACT_ROUTE_PATHS,
    ),
    surface(
        "hr-onboarding-checklist",
        console_hr_rest::checklist::CHECKLIST_ROUTE_PATHS,
    ),
    surface(
        "hr-fixed-term",
        console_hr_rest::fixed_term::FIXED_TERM_ROUTE_PATHS,
    ),
    surface(
        "hr-job-titles",
        console_hr_rest::job_title::JOB_TITLE_ROUTE_PATHS,
    ),
    surface(
        "hr-lifecycle-void",
        console_hr_rest::lifecycle_void::LIFECYCLE_VOID_ROUTE_PATHS,
    ),
    surface(
        "hr-lifecycle-bulk-job",
        console_hr_rest::lifecycle_bulk_job::LIFECYCLE_BULK_JOB_ROUTE_PATHS,
    ),
    surface(
        "hr-change-requests",
        console_hr_rest::requests::CHANGE_REQUESTS_ROUTE_PATHS,
    ),
    surface(
        "hr-corrections",
        console_hr_rest::corrections::CORRECTIONS_ROUTE_PATHS,
    ),
    surface(
        "hr-registration",
        console_hr_rest::registration::REGISTRATION_ROUTE_PATHS,
    ),
    surface("hr-intake", console_hr_rest::intake::INTAKE_ROUTE_PATHS),
    // IMPORT-2: RRN read/reveal, 사번 변경, numbering rules, renumbering.
    surface(
        "hr-identity",
        console_hr_rest::identity::IDENTITY_ROUTE_PATHS,
    ),
    surface(
        "hr-change-sets",
        console_hr_rest::change_sets::CHANGE_SET_ROUTE_PATHS,
    ),
    surface(
        "hr-bulk-corrections",
        console_hr_rest::bulk_corrections::BULK_CORRECTION_ROUTE_PATHS,
    ),
    surface(
        "hr-register-facts",
        console_hr_rest::register_facts::REGISTER_FACTS_ROUTE_PATHS,
    ),
    surface(
        "hr-personal-facts",
        console_hr_rest::personal_facts::PERSONAL_FACTS_ROUTE_PATHS,
    ),
    // BE-EMP-UI: bulk 발령 preview, 발령 공고, 이관 확인.
    surface(
        "hr-bulk-lifecycle",
        console_hr_rest::bulk_lifecycle::BULK_LIFECYCLE_ROUTE_PATHS,
    ),
    surface(
        "hr-appointment-notices",
        console_hr_rest::notices::APPOINTMENT_NOTICE_ROUTE_PATHS,
    ),
    surface(
        "hr-import-reconcile",
        console_hr_rest::reconcile::RECONCILE_ROUTE_PATHS,
    ),
    #[cfg(feature = "workspace")]
    surface(
        "workflow-studio",
        crate::workflow_studio::WORKFLOW_STUDIO_ROUTE_PATHS,
    ),
    #[cfg(feature = "workspace")]
    surface(
        "collaboration",
        crate::collaboration::COLLABORATION_ROUTE_PATHS,
    ),
    #[cfg(feature = "sales")]
    surface("sales", console_sales_rest::SALES_ROUTE_PATHS),
    #[cfg(feature = "reporting")]
    surface("reporting", console_reporting_rest::KPI_ROUTE_PATHS),
    #[cfg(feature = "workorder")]
    surface("workorder", console_workorder_rest::WORKORDER_ROUTE_PATHS),
    #[cfg(feature = "workorder")]
    surface(
        "workorder-mobile",
        console_workorder_rest::MOBILE_ROUTE_PATHS,
    ),
    #[cfg(feature = "facilities")]
    surface(
        "facilities",
        console_facilities_rest::FACILITIES_ROUTE_PATHS,
    ),
    #[cfg(feature = "production")]
    surface(
        "production",
        console_production_rest::PRODUCTION_ROUTE_PATHS,
    ),
    #[cfg(feature = "messenger")]
    surface("messenger", console_messenger_rest::MESSENGER_ROUTE_PATHS),
    #[cfg(feature = "mail")]
    surface("comms", console_comms_rest::COMMS_ROUTE_PATHS),
    surface("platform", console_platform_rest::PLATFORM_ROUTE_PATHS),
    surface("auth", console_platform_auth_rest::AUTH_ROUTE_PATHS),
    surface("realtime", console_platform_realtime::WS_ROUTE_PATHS),
    surface(
        "realtime-events",
        console_platform_realtime::sse::EVENTS_ROUTE_PATHS,
    ),
    #[cfg(feature = "ontology")]
    surface("ontology", console_ontology_rest::ONTOLOGY_ROUTE_PATHS),
    #[cfg(feature = "governance")]
    surface(
        "governance",
        console_governance_rest::GOVERNANCE_ROUTE_PATHS,
    ),
    surface("orgchange", console_orgchange_rest::ORG_CHANGE_ROUTE_PATHS),
    surface("entity", console_entity_rest::ENTITY_ROUTE_PATHS),
    surface(
        "onboarding",
        console_onboarding_rest::ONBOARDING_ROUTE_PATHS,
    ),
    surface(
        "policy",
        console_platform_authz_rest::CEDAR_POLICY_ROUTE_PATHS,
    ),
    surface("access", console_platform_access_rest::ACCESS_ROUTE_PATHS),
    #[cfg(feature = "docs")]
    surface("evidence", console_docs_rest::EVIDENCE_ROUTE_PATHS),
    #[cfg(feature = "notices")]
    surface("notices", console_notices_rest::NOTICES_ROUTE_PATHS),
    #[cfg(feature = "finance-gl")]
    surface(
        "finance-gl",
        console_finance_gl_rest::FINANCE_GL_ROUTE_PATHS,
    ),
    #[cfg(feature = "payroll")]
    surface("payroll", console_payroll_rest::PAYROLL_ROUTE_PATHS),
    #[cfg(feature = "analytics-quant")]
    surface(
        "analytics",
        console_analytics_quant_rest::ANALYTICS_QUANT_ROUTE_PATHS,
    ),
    #[cfg(feature = "equipment")]
    surface(
        "equipment-3r",
        console_equipment_rest::EQUIPMENT_3R_ROUTE_PATHS,
    ),
    #[cfg(feature = "notifications")]
    surface(
        "notifications",
        console_notifications_rest::NOTIFICATIONS_ROUTE_PATHS,
    ),
    #[cfg(feature = "recruiting")]
    surface(
        "recruiting",
        console_recruiting_rest::RECRUITING_ROUTE_PATHS,
    ),
    // The hire handshake is the one recruiting route that lives in the app
    // crate (acceptance → employee creation must go through the HR-owned core
    // in one transaction), so it is its own surface rather than an entry the
    // recruiting crate could export.
    #[cfg(feature = "recruiting")]
    surface(
        "recruiting-hire",
        crate::recruiting_hire::RECRUITING_HIRE_ROUTE_PATHS,
    ),
];

#[cfg(all(test, feature = "production"))]
#[cfg(not(feature = "test-postgres"))]
mod production_route_surface_tests {
    use super::*;
    use console_production_rest::{
        PRODUCTION_CAPACITY_SLOTS_PATH, PRODUCTION_OPERATION_RECORDS_PATH, PRODUCTION_PLAN_PATH,
        PRODUCTION_PLAN_RELEASE_PATH, PRODUCTION_PLANS_PATH, PRODUCTION_SOURCE_INGRESS_PATH,
        PRODUCTION_SOURCE_SYSTEM_DISABLE_PATH, PRODUCTION_SOURCE_SYSTEM_ROTATE_PATH,
        PRODUCTION_SOURCE_SYSTEMS_PATH,
    };

    #[test]
    fn production_execution_routes_are_assembled_and_contract_stable() {
        let production = CONFIGURED_ROUTE_SURFACES
            .iter()
            .find(|surface| surface.name == "production")
            .expect("production router must be mounted in the application");
        assert_eq!(
            production.paths,
            [
                PRODUCTION_PLANS_PATH,
                PRODUCTION_CAPACITY_SLOTS_PATH,
                PRODUCTION_PLAN_PATH,
                PRODUCTION_PLAN_RELEASE_PATH,
                PRODUCTION_OPERATION_RECORDS_PATH,
                PRODUCTION_SOURCE_INGRESS_PATH,
                PRODUCTION_SOURCE_SYSTEMS_PATH,
                PRODUCTION_SOURCE_SYSTEM_ROTATE_PATH,
                PRODUCTION_SOURCE_SYSTEM_DISABLE_PATH,
            ]
        );
    }
}
