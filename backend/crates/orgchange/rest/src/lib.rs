//! Authenticated org-change routes (STORY-ORG-001).
//!
//! Draft creation, editing, preflight, submit and cancellation share Cedar
//! authority inside the store transaction. Missing create authority is 403;
//! inaccessible existing rows are concealed as 404 by the scoped decision and RLS.
//!
//! Feature floors: `org_change_read/draft/approve/apply` are
//! `console_platform_authz::Feature` variants; each route checks the matrix row
//! (`permission_for`, also projected by `/api/v1/me/authz`) or a custom grant.
//! OrgUnit reads ride on `org_change_read`, OrgUnit writes on `org_change_draft`.
mod access;
mod access_log;
mod dto;
mod error;
mod legacy;
mod openapi;
mod org_units;
mod requests;

use access::*;
use dto::*;
use error::*;
use legacy::*;
pub use openapi::OPENAPI_FRAGMENT;
use org_units::*;
use requests::*;

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use console_kernel_core::{BranchId, ErrorKind, KernelError, UserId};
use console_orgchange_adapter_postgres::{
    CreateOrgChange, DraftPatch, ListFilter, PgOrgChangeError, PgOrgChangeStore,
};
use console_orgchange_domain::{
    ORG_CHANGE_CODES, ORG_STRUCTURE_CODES, OrgChangeKind, OrgChangeStatus, OrgChangeTarget,
    OrgProposalOp, OrgUnitKind, TargetKind,
};
use console_platform_auth::JwtVerifier;
use console_platform_authz::{
    Action, Feature, PermissionLevel, Principal, authorize_capability, permission_for,
};
use console_platform_request_context::RequestContextError;
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::{Date, OffsetDateTime, macros::offset};
use uuid::Uuid;

// The workspace `time` build has no `serde-human-readable`, so a bare `Date`
// would be read off the wire as `[year, ordinal]`; this pins `YYYY-MM-DD`.
time::serde::format_description!(iso_date, Date, "[year]-[month]-[day]");

pub const ORG_CHANGE_ROUTE_PATHS: &[&str] = &[
    "/api/v1/regions",
    "/api/v1/regions/{id}",
    "/api/v1/branches",
    "/api/v1/branches/{id}",
    "/api/v1/org-changes",
    "/api/v1/org-changes/{id}",
    "/api/v1/org-changes/{id}/preflight",
    "/api/v1/org-changes/{id}/submit",
    "/api/v1/org-changes/{id}/approval-steps/{step_id}/decision",
    "/api/v1/org-changes/{id}/effectuate",
    "/api/v1/org-changes/{id}/settlement-items/{item_id}/complete",
    "/api/v1/org-changes/{id}/archive",
    "/api/v1/org-changes/{id}/cancel",
    "/api/v1/org-entities",
    "/api/v1/org-units",
    "/api/v1/org-units/{id}",
];

#[derive(Clone)]
pub struct OrgChangeRestState {
    store: PgOrgChangeStore,
    jwt: Option<JwtVerifier>,
}

impl OrgChangeRestState {
    #[must_use]
    pub fn new(store: PgOrgChangeStore, jwt: Option<JwtVerifier>) -> Self {
        Self { store, jwt }
    }

    /// SSR composition helper: the same org-entity listing as GET
    /// `/org-entities`, or empty (omit) when unauthenticated, unauthorized,
    /// or the listing fails.
    pub async fn visible_org_entities(&self, headers: &HeaderMap) -> Vec<VisibleOrgEntity> {
        list_visible_org_entities(self, headers)
            .await
            .unwrap_or_default()
    }
}

/// Org entity already authorized for SSR. Required `OrgEntitySummary` keys.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VisibleOrgEntity {
    pub org_id: String,
    pub slug: String,
    pub name: String,
    pub status: String,
}

pub fn router(state: OrgChangeRestState) -> Router {
    let verifier = state.jwt.clone();
    let pool = state.store.pool().clone();
    let r = Router::new()
        // Legacy org-setup mutations remain at their established URLs, but the
        // orgchange feature owns the handlers and persists only typed drafts.
        // Identity mounts the GET methods on these same paths.
        .route("/api/v1/regions", post(legacy_create_region))
        .route(
            "/api/v1/regions/{id}",
            axum::routing::patch(legacy_update_region).delete(legacy_deactivate_region),
        )
        .route("/api/v1/branches", post(legacy_create_branch))
        .route(
            "/api/v1/branches/{id}",
            axum::routing::patch(legacy_update_branch).delete(legacy_deactivate_branch),
        )
        .route("/api/v1/org-changes", post(create).get(list))
        .route("/api/v1/org-changes/{id}", get(detail).patch(update_draft))
        .route("/api/v1/org-changes/{id}/preflight", post(preflight))
        .route("/api/v1/org-changes/{id}/submit", post(submit))
        .route(
            "/api/v1/org-changes/{id}/approval-steps/{step_id}/decision",
            post(decide),
        )
        .route("/api/v1/org-changes/{id}/effectuate", post(effectuate))
        .route(
            "/api/v1/org-changes/{id}/settlement-items/{item_id}/complete",
            post(complete_settlement),
        )
        .route("/api/v1/org-changes/{id}/archive", post(archive))
        .route("/api/v1/org-changes/{id}/cancel", post(cancel))
        .route("/api/v1/org-entities", get(org_entities))
        // Canonical org tree (Site/Department/Team under the Company root).
        // Reads are direct; every write is a DRAFT org change (same pattern as
        // the legacy region/branch URLs above).
        .route(
            "/api/v1/org-units",
            get(list_org_units).post(draft_create_org_unit),
        )
        .route(
            "/api/v1/org-units/{id}",
            get(get_org_unit)
                .patch(draft_update_org_unit)
                .delete(draft_dissolve_org_unit),
        )
        .with_state(state);
    console_platform_request_context::with_request_context(r, verifier, pool)
}

mod filters;
