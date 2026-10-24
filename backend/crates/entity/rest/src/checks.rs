// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::{
    EntityRestState,
    auth::{Need, actor, manager},
    error::RestError,
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use console_entity_application::{
    Target,
    registration_check::{
        CheckAvailability, CheckKind, RegistrationCheck, UnavailableReason, UserValidation,
    },
};
use console_entity_domain::Refusal;
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;

fn port(s: &EntityRestState) -> Result<Arc<dyn RegistrationCheck>, RestError> {
    s.checks.clone().ok_or_else(|| {
        Refusal::conflict(
            "registration_check_unavailable",
            "issuing-authority check is not configured",
        )
        .with_remedy("NOT_CONFIGURED")
        .into()
    })
}
pub(crate) fn current_availability(s: &EntityRestState) -> CheckAvailability {
    s.checks.as_ref().map_or_else(
        || CheckAvailability::unavailable(UnavailableReason::NotConfigured),
        |p| p.availability(),
    )
}
pub(crate) fn mark_availability(
    s: &EntityRestState,
    e: &mut console_entity_application::LegalEntityView,
) {
    if !current_availability(s).available {
        for r in &mut e.registrations {
            if r.brn.is_some() && r.nts_check.is_none() {
                r.unverified_reason =
                    Some(console_entity_domain::codes::UnverifiedReason::ServiceUnavailable);
            }
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request {
    kind: CheckKind,
    expected: Option<UserValidation>,
}
#[derive(Deserialize)]
pub(crate) struct Page {
    limit: Option<i64>,
    before: Option<Uuid>,
}

pub(crate) async fn create(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Request>,
) -> Result<Json<Value>, RestError> {
    let a = manager(&s, &h, Target::Registration(id)).await?;
    let check = s
        .store
        .check_registration_expected(&a, id, body.kind, body.expected, port(&s)?)
        .await?;
    Ok(Json(json!(check)))
}
pub(crate) async fn history(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Query(page): Query<Page>,
) -> Result<Json<Value>, RestError> {
    let (a, _) = actor(&s, &h, Need::Read, Target::Registration(id)).await?;
    let history = s
        .store
        .registration_checks(&a, id, page.limit.unwrap_or(20), page.before)
        .await?;
    let mut result = json!(history);
    result["availability"] = json!(current_availability(&s));
    Ok(Json(result))
}
pub(crate) async fn availability(
    State(s): State<EntityRestState>,
    h: HeaderMap,
) -> Result<Json<CheckAvailability>, RestError> {
    actor(&s, &h, Need::Read, Target::Tenant).await?;
    Ok(Json(current_availability(&s)))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Preview {
    kind: CheckKind,
    #[serde(flatten)]
    values: UserValidation,
}
pub(crate) async fn preview(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Json(body): Json<Preview>,
) -> Result<Json<Value>, RestError> {
    let a = manager(&s, &h, Target::Tenant).await?;
    Ok(Json(json!(
        s.store
            .preview_registration_check(&a, body.kind, body.values, port(&s)?)
            .await?
    )))
}
