//! 법인 · 사업장 REST face (entity-depth design §3, §6).
//!
//! Reads need the org-change read permission (ADMIN and above); 법인 ·
//! 사업자등록 · 사업장 writes need the Cedar action `legal_entity_manage`
//! (decisions #14.2) within the caller's scope (#15); setup 부서 units keep
//! the org-change apply permission; employment assignment needs the
//! employee-directory manage permission (`auth.rs`). Restricted personal
//! fields (대표자, 공동사업자) are returned only to callers who may manage them. Every write is admitted against the tenant
//! phase by the adapter: immediate and marked SETUP before 운영 시작,
//! governed after.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

mod openapi;
pub use openapi::OPENAPI_FRAGMENT;

mod asof;
mod auth;
// --- lane: UX-R2 ENDS ---
mod close_plan;
mod corrections;
mod docs;
// --- lane: CRUD ---
mod ends;
mod error;
mod handlers;
mod org_setup;
mod reach;
mod records;
mod reference;
mod setup_batches;
mod structure;
mod workplace_kind;

use std::sync::Arc;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::routing::{get, patch, post};
use console_entity_adapter_juso::JusoClient;
use console_entity_adapter_postgres::{
    GovernedCorrectionPort, OrgUnitSetupWritePort, PgEntityStore,
};
use console_platform_auth::JwtVerifier;

pub const LEGAL_ENTITIES_PATH: &str = "/api/v1/legal-entities";
pub const LEGAL_ENTITY_PATH: &str = "/api/v1/legal-entities/{entityId}";
pub const LEGAL_ENTITY_ROLES_PATH: &str = "/api/v1/legal-entities/{entityId}/roles";
pub const LEGAL_ENTITY_NAME_REVIEW_PATH: &str =
    "/api/v1/legal-entities/{entityId}/name-reviews/{reviewId}/settle";
pub const LEGAL_ENTITY_VOID_PATH: &str = "/api/v1/legal-entities/{entityId}/void";
pub const LEGAL_ENTITY_REGISTRATIONS_PATH: &str = "/api/v1/legal-entities/{entityId}/registrations";
pub const LEGAL_ENTITY_WORKPLACES_PATH: &str = "/api/v1/legal-entities/{entityId}/workplaces";
pub const REGISTRATION_PATH: &str = "/api/v1/business-registrations/{registrationId}";
pub const REGISTRATION_END_OPTIONS_PATH: &str =
    "/api/v1/business-registrations/{registrationId}/end-options";
pub const REGISTRATION_VOID_PATH: &str = "/api/v1/business-registrations/{registrationId}/void";
pub const WORKPLACES_PATH: &str = "/api/v1/workplaces";
pub const WORKPLACE_PATH: &str = "/api/v1/workplaces/{workplaceId}";
pub const WORKPLACE_VOID_PATH: &str = "/api/v1/workplaces/{workplaceId}/void";
pub const WORKPLACE_KIND_PATH: &str = "/api/v1/workplaces/{workplaceId}/kind";
pub const WORKPLACE_CODE_PATH: &str = "/api/v1/workplaces/{workplaceId}/code";
pub const WORKPLACE_KINDS_PATH: &str = "/api/v1/workplace-kinds";
pub const WORKPLACE_KINDS_ITEM_PATH: &str = "/api/v1/workplace-kinds/{code}";
pub const ORG_STRUCTURE_DIFF_PATH: &str = "/api/v1/org-structure/diff";
pub const ORG_STRUCTURE_DATES_PATH: &str = "/api/v1/org-structure/change-dates";
pub const ORG_STRUCTURE_MEMBERS_PATH: &str = "/api/v1/org-structure/units/{orgUnitId}/members";
pub const ORG_STRUCTURE_PATH: &str = "/api/v1/org-structure";
pub const ORG_STRUCTURE_UNITS_PATH: &str = "/api/v1/org-structure/units";
pub const ORG_STRUCTURE_UNIT_PATH: &str = "/api/v1/org-structure/units/{orgUnitId}";
pub const ORG_STRUCTURE_BATCHES_PATH: &str = "/api/v1/org-structure/batches";
pub const ORG_STRUCTURE_BATCH_UNDO_PATH: &str = "/api/v1/org-structure/batches/{batchId}/undo";
pub const ORG_STRUCTURE_ORDER_PATH: &str = "/api/v1/org-structure/order";
pub const ASSIGNMENTS_PATH: &str = "/api/v1/employment-assignments";
pub const UNMAPPED_COMPANIES_PATH: &str = "/api/v1/employment-assignments/unmapped-companies";
pub const MAP_COMPANY_PATH: &str = "/api/v1/employment-assignments/map-company";
// --- lane: ENT-CAPTURE ---
pub const LEGAL_ENTITY_REVISIONS_PATH: &str = "/api/v1/legal-entities/{entityId}/revisions";
pub const LEGAL_ENTITY_DOCUMENTS_PATH: &str = "/api/v1/legal-entities/{entityId}/documents";
pub const REGISTRATION_REVISIONS_PATH: &str =
    "/api/v1/business-registrations/{registrationId}/revisions";
pub const WORKPLACE_REVISIONS_PATH: &str = "/api/v1/workplaces/{workplaceId}/revisions";
pub const WORKPLACE_INSURANCE_PATH: &str = "/api/v1/workplaces/{workplaceId}/insurance";
pub const DOCUMENTS_PATH: &str = "/api/v1/entity-documents";
pub const DOCUMENT_PATH: &str = "/api/v1/entity-documents/{id}";
pub const DOCUMENT_CONTENT_PATH: &str = "/api/v1/entity-documents/{id}/content";
pub const REF_LIST_CODES_PATH: &str = "/api/v1/ref/lists/{key}/codes";
pub const ADDRESS_SEARCH_PATH: &str = "/api/v1/ref/address-search";
pub const ADDRESS_DETAIL_PATH: &str = "/api/v1/ref/address-detail";
// --- lane: ENT-REG ---
pub const LEGAL_ENTITY_IDENTIFIER_CORRECTIONS_PATH: &str =
    "/api/v1/legal-entities/{entityId}/identifier-corrections";
pub const REGISTRATION_IDENTIFIER_CORRECTIONS_PATH: &str =
    "/api/v1/business-registrations/{registrationId}/identifier-corrections";
pub const REGISTRATION_REISSUES_PATH: &str =
    "/api/v1/business-registrations/{registrationId}/reissues";
pub const WORKPLACE_REGISTRATION_CHANGES_PATH: &str =
    "/api/v1/workplaces/{workplaceId}/registration-changes";
// --- lane: ENT-REG close (MR-15) ---
pub const LEGAL_ENTITY_CLOSE_PATH: &str = "/api/v1/legal-entities/{entityId}/close";
// --- lane: ENT-SHEET (MR-29) ---
pub const ENTITY_SETUP_BATCHES_PATH: &str = "/api/v1/entity-setup/batches";
pub const ENTITY_SETUP_BATCH_UNDO_PATH: &str = "/api/v1/entity-setup/batches/{batchId}/undo";
// --- lane: CRUD ---
pub const ORG_STRUCTURE_UNIT_END_OPTIONS_PATH: &str =
    "/api/v1/org-structure/units/{orgUnitId}/end-options";
pub const ORG_STRUCTURE_UNIT_ERASE_PATH: &str = "/api/v1/org-structure/units/{orgUnitId}/erase";
pub const ORG_STRUCTURE_UNIT_DISSOLVE_PATH: &str =
    "/api/v1/org-structure/units/{orgUnitId}/dissolve";
pub const ORG_STRUCTURE_UNIT_DETAILS_PATH: &str = "/api/v1/org-structure/units/{orgUnitId}/details";
pub const LEGAL_ENTITY_END_OPTIONS_PATH: &str = "/api/v1/legal-entities/{entityId}/end-options";
pub const WORKPLACE_END_OPTIONS_PATH: &str = "/api/v1/workplaces/{workplaceId}/end-options";
// --- lane: UX-R2 ENDS ---
pub const WORKPLACE_CLOSE_PLAN_PATH: &str = "/api/v1/workplaces/{workplaceId}/close-plan";
pub const WORKPLACE_CLOSE_PLAN_CANCEL_PATH: &str =
    "/api/v1/workplaces/{workplaceId}/close-plan/cancel";

mod route_inventory;
pub use route_inventory::ENTITY_ROUTE_PATHS;

#[derive(Clone)]
pub struct EntityRestState {
    store: PgEntityStore,
    jwt_verifier: Option<JwtVerifier>,
    /// The canonical OrgUnit seam (composition root). `None` refuses setup
    /// org-unit writes with 503 rather than writing outside the owner.
    org_units: Option<Arc<dyn OrgUnitSetupWritePort>>,
    /// The juso proxies. `None` answers `UNAVAILABLE` (manual entry).
    juso: Option<Arc<JusoClient>>,
    /// The BW-06 consumer for post-go-live identifier corrections. `None`
    /// refuses them (`identifier_correction_unavailable`; fail closed).
    governed: Option<Arc<dyn GovernedCorrectionPort>>,
}

impl EntityRestState {
    #[must_use]
    pub fn new(
        store: PgEntityStore,
        jwt_verifier: Option<JwtVerifier>,
        org_units: Option<Arc<dyn OrgUnitSetupWritePort>>,
    ) -> Self {
        Self {
            store,
            jwt_verifier,
            org_units,
            juso: None,
            governed: None,
        }
    }

    /// Serve 도로명주소 / 상세주소 search through `juso` (keys from the server
    /// environment, `JusoConfig::from_env`).
    #[must_use]
    pub fn with_juso(mut self, juso: Arc<JusoClient>) -> Self {
        self.juso = Some(juso);
        self
    }

    /// Admit post-go-live identifier corrections through governed exceptions.
    #[must_use]
    pub fn with_governed_corrections(mut self, port: Arc<dyn GovernedCorrectionPort>) -> Self {
        self.governed = Some(port);
        self
    }
}

pub fn router(state: EntityRestState) -> Router {
    use axum::routing::put;
    use handlers as h;
    use org_setup as o;
    use workplace_kind as k;
    let verifier = state.jwt_verifier.clone();
    let pool = state.store.pool().clone();
    let router = Router::new()
        .route(
            LEGAL_ENTITIES_PATH,
            get(h::list_entities).post(docs::create_entity),
        )
        .route(LEGAL_ENTITY_PATH, get(h::get_entity).put(h::revise_entity))
        .route(LEGAL_ENTITY_ROLES_PATH, post(h::set_roles))
        .route(LEGAL_ENTITY_NAME_REVIEW_PATH, post(h::settle_name_review))
        .route(LEGAL_ENTITY_VOID_PATH, post(h::void_entity))
        .route(
            LEGAL_ENTITY_CLOSE_PATH,
            post(h::close_entity)
                .put(h::correct_close)
                .delete(h::withdraw_close),
        )
        .route(
            LEGAL_ENTITY_REGISTRATIONS_PATH,
            post(docs::create_registration),
        )
        .route(
            LEGAL_ENTITY_WORKPLACES_PATH,
            get(asof::workplaces).post(h::create_workplace),
        )
        .route(REGISTRATION_PATH, put(docs::revise_registration))
        .route(REGISTRATION_VOID_PATH, post(h::void_registration))
        .route(WORKPLACES_PATH, get(h::list_workplaces))
        .route(
            REGISTRATION_END_OPTIONS_PATH,
            get(ends::registration_end_options),
        )
        .route(
            WORKPLACE_PATH,
            get(asof::workplace).put(h::revise_workplace),
        )
        .route(WORKPLACE_VOID_PATH, post(h::void_workplace))
        .route(WORKPLACE_KIND_PATH, put(k::set_kind))
        .route(WORKPLACE_CODE_PATH, put(structure::set_code))
        .route(
            WORKPLACE_KINDS_PATH,
            get(k::list_kinds).post(k::create_kind),
        )
        .route(WORKPLACE_KINDS_ITEM_PATH, patch(k::update_kind))
        .route(ORG_STRUCTURE_PATH, get(h::org_structure))
        .route(ORG_STRUCTURE_DIFF_PATH, get(asof::diff))
        .route(ORG_STRUCTURE_DATES_PATH, get(asof::dates))
        .route(ORG_STRUCTURE_MEMBERS_PATH, get(asof::members))
        .route(ORG_STRUCTURE_UNITS_PATH, post(o::create_setup_unit))
        .route(
            ORG_STRUCTURE_UNIT_PATH,
            patch(o::rename_setup_unit).delete(o::dissolve_setup_unit),
        )
        .route(
            ORG_STRUCTURE_BATCHES_PATH,
            get(o::list_batches).post(o::apply_batch),
        )
        .route(ORG_STRUCTURE_BATCH_UNDO_PATH, post(o::undo_batch))
        .route(ORG_STRUCTURE_ORDER_PATH, put(structure::reorder))
        .route(
            ASSIGNMENTS_PATH,
            get(h::list_assignments).post(h::bind_assignment),
        )
        .route(UNMAPPED_COMPANIES_PATH, get(h::unmapped_companies))
        .route(MAP_COMPANY_PATH, post(h::map_company))
        .route(LEGAL_ENTITY_REVISIONS_PATH, get(records::entity_history))
        .route(
            REGISTRATION_REVISIONS_PATH,
            get(records::registration_history),
        )
        .route(WORKPLACE_REVISIONS_PATH, get(records::workplace_history))
        .route(WORKPLACE_INSURANCE_PATH, put(records::revise_insurance))
        .route(LEGAL_ENTITY_DOCUMENTS_PATH, get(docs::list))
        .route(
            DOCUMENTS_PATH,
            post(docs::upload).layer(DefaultBodyLimit::max(docs::UPLOAD_BODY_LIMIT)),
        )
        .route(DOCUMENT_PATH, get(docs::get))
        .route(DOCUMENT_CONTENT_PATH, get(docs::content))
        .route(REF_LIST_CODES_PATH, get(reference::codes))
        .route(ADDRESS_SEARCH_PATH, get(reference::address_search))
        .route(ADDRESS_DETAIL_PATH, get(reference::address_detail))
        .route(
            LEGAL_ENTITY_IDENTIFIER_CORRECTIONS_PATH,
            post(corrections::correct_entity),
        )
        .route(
            REGISTRATION_IDENTIFIER_CORRECTIONS_PATH,
            post(corrections::correct_registration),
        )
        .route(
            WORKPLACE_REGISTRATION_CHANGES_PATH,
            post(corrections::change_registration),
        )
        .route(REGISTRATION_REISSUES_PATH, post(corrections::reissue))
        .route(
            ENTITY_SETUP_BATCHES_PATH,
            get(setup_batches::list).post(setup_batches::run),
        )
        .route(ENTITY_SETUP_BATCH_UNDO_PATH, post(setup_batches::undo))
        .route(
            ORG_STRUCTURE_UNIT_END_OPTIONS_PATH,
            get(ends::unit_end_options),
        )
        .route(ORG_STRUCTURE_UNIT_ERASE_PATH, post(ends::erase_unit))
        .route(ORG_STRUCTURE_UNIT_DISSOLVE_PATH, post(ends::dissolve_unit))
        .route(ORG_STRUCTURE_UNIT_DETAILS_PATH, put(ends::set_unit_details))
        .route(LEGAL_ENTITY_END_OPTIONS_PATH, get(ends::entity_end_options))
        .route(WORKPLACE_END_OPTIONS_PATH, get(ends::workplace_end_options))
        .route(
            WORKPLACE_CLOSE_PLAN_PATH,
            get(close_plan::read).post(close_plan::plan),
        )
        .route(WORKPLACE_CLOSE_PLAN_CANCEL_PATH, post(close_plan::cancel))
        .with_state(state);
    console_platform_request_context::with_request_context(router, verifier, pool)
}
