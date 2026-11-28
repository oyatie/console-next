// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{
    ComplianceRestState, Feature, Principal, accept_evidence_binding, branch_navigation_available,
    create_evidence_binding, create_framework, create_framework_control, create_obligation,
    create_regulation, link_control_obligation, link_obligation_regulation, list_evidence_bindings,
    list_framework_controls, list_frameworks, list_obligations, list_regulations,
};
use axum::{
    Router,
    routing::{get, post},
};
use serde::Deserialize;

time::serde::format_description!(iso_date, Date, "[year]-[month]-[day]");

/// Current clients send ISO dates. Earlier catalog clients could send the native time tuple.
pub(super) fn optional_date<'de, D>(d: D) -> Result<Option<time::Date>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(serde::Deserialize)]
    #[serde(untagged)]
    enum DateInput {
        Iso(#[serde(with = "iso_date")] time::Date),
        Legacy(time::Date),
    }
    Ok(Option::<DateInput>::deserialize(d)?.map(|date| match date {
        DateInput::Iso(value) | DateInput::Legacy(value) => value,
    }))
}

pub(super) fn empty_metadata() -> serde_json::Value {
    serde_json::json!({})
}
pub(super) fn empty_requirements() -> serde_json::Value {
    serde_json::json!([])
}

/// The register includes branch obligations. Navigation can expose a permitted branch without opening any
/// tenant-wide register. Each request authorizes its actual scope in the owning handler.
pub fn catalog_access(principal: &Principal) -> (bool, bool) {
    (
        branch_navigation_available(principal, Feature::ComplianceDomainRead),
        branch_navigation_available(principal, Feature::ComplianceDomainManage),
    )
}

pub(super) fn routes() -> Router<ComplianceRestState> {
    Router::new()
        .route(
            "/api/v1/compliance/regulations",
            get(list_regulations).post(create_regulation),
        )
        .route(
            "/api/v1/compliance/obligations",
            get(list_obligations).post(create_obligation),
        )
        .route(
            "/api/v1/compliance/obligation-regulation-links",
            post(link_obligation_regulation),
        )
        .route(
            "/api/v1/compliance/frameworks",
            get(list_frameworks).post(create_framework),
        )
        .route(
            "/api/v1/compliance/framework-controls",
            get(list_framework_controls).post(create_framework_control),
        )
        .route(
            "/api/v1/compliance/control-obligation-coverage",
            post(link_control_obligation),
        )
        .route(
            "/api/v1/compliance/evidence-bindings",
            get(list_evidence_bindings).post(create_evidence_binding),
        )
        .route(
            "/api/v1/compliance/evidence-bindings/{id}/accept",
            post(accept_evidence_binding),
        )
}
