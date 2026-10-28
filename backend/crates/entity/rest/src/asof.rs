//! Dated record reads and chart timeline routes retain the normal Cedar read gate.
use crate::{
    EntityRestState,
    auth::{Need, actor, read_gate},
    error::RestError,
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
};
use console_entity_application::{Actor, AsOfQuery, CompareQuery, Target};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

pub(crate) async fn workplace(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Query(q): Query<AsOfQuery>,
) -> Result<Response, RestError> {
    let (a, personal, gate) = read_gate(&s, &h, Need::Read, Target::Workplace(id)).await?;
    let mut w = s
        .store
        .get_workplace_at(&a, id, personal, validated(&s, &a, q.parse()).await?)
        .await?;
    w.can_manage = !w.read.read_only && gate.may(&[w.legal_entity_id, w.id]);
    Ok(Json(w).into_response())
}
pub(crate) async fn workplaces(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Query(q): Query<AsOfQuery>,
) -> Result<Response, RestError> {
    let (a, personal, gate) = read_gate(&s, &h, Need::Read, Target::Entity(id)).await?;
    let mut e = s
        .store
        .get_entity_at(&a, id, personal, validated(&s, &a, q.parse()).await?)
        .await?;
    for w in &mut e.workplaces {
        w.can_manage = !w.read.read_only && gate.may(&[e.id, w.id]);
    }
    Ok(Json(json!({"items":e.workplaces})).into_response())
}
pub(crate) async fn diff(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Query(q): Query<CompareQuery>,
) -> Result<Response, RestError> {
    let (a, _) = actor(&s, &h, Need::Read, Target::Tenant).await?;
    let (from, to, options) = validated(&s, &a, q.parse()).await?;
    Ok(Json(s.store.structure_diff(&a, from, to, options).await?).into_response())
}
#[derive(Deserialize)]
pub(crate) struct DateRange {
    from: String,
    to: String,
    known_at: Option<String>,
}
pub(crate) async fn dates(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Query(q): Query<DateRange>,
) -> Result<Response, RestError> {
    let (a, _) = actor(&s, &h, Need::Read, Target::Tenant).await?;
    let (from, to, options) = validated(
        &s,
        &a,
        CompareQuery {
            a: q.from,
            b: q.to,
            known_at: q.known_at,
        }
        .parse(),
    )
    .await?;
    Ok(
        Json(json!({"items":s.store.structure_change_dates(&a,from,to,options).await?}))
            .into_response(),
    )
}

pub(crate) async fn validated<T>(
    s: &EntityRestState,
    actor: &Actor,
    parsed: Result<T, console_entity_domain::Refusal>,
) -> Result<T, RestError> {
    match parsed {
        Ok(value) => Ok(value),
        Err(refusal) => {
            s.store.record_temporal_refusal(actor, &refusal).await?;
            Err(refusal.into())
        }
    }
}

pub(crate) async fn members(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Query(q): Query<AsOfQuery>,
) -> Result<Response, RestError> {
    let (a, _, gate) = crate::auth::read_gate(&s, &h, Need::Read, Target::Tenant).await?;
    let options = validated(&s, &a, q.parse()).await?;
    let members = s.store.structure_members_at(&a, id, options).await?;
    let subjects: Vec<_> = members.items.iter().map(|m| m.employee_id).collect();
    console_platform_request_context::audit_context::access_log::record_person_access(
        s.store.pool(),
        &gate.principal,
        console_platform_request_context::audit_context::access_log::AccessRecord {
            action: "org_unit.members_read",
            target_type: "org_unit",
            target_id: id.to_string(),
            subject_ids: &subjects,
            reader_subject: None,
            details: json!({}),
        },
        &[],
    )
    .await
    .map_err(|_| {
        console_entity_domain::Refusal::new(
            console_kernel_core::ErrorKind::Unavailable,
            "unavailable",
            "org unit access record could not be recorded",
        )
    })?;
    Ok(Json(members).into_response())
}
