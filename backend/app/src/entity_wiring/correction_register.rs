// SPDX-License-Identifier: LicenseRef-Proprietary
//! The entity correction inbox and controller review, using the same second-person facts as decisions.
use super::corrections::governance_kernel;
use super::exceptions::{EntityWiringState, decision_error, decision_facts, principal};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use console_entity_adapter_postgres::identifier_correction_register::{
    self as register, CorrectionCase,
};
use console_governance_adapter_postgres::{PgGovernanceError, exception::get_exception_conn};
use console_governance_domain::exception::{ExceptionStatus, RuleCode};
use console_kernel_core::{AuditAction, AuditEvent, BranchScope, KernelError, TraceContext};
use console_platform_authz::cedar_pbac::{enforce::enforce_action, facts::Facts};
use console_platform_authz::{
    Action, AuthorizationResource, Feature, Principal, authorize_capability,
};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

const PAGE_SIZE: i64 = 50;

#[derive(Default, Deserialize)]
struct RegisterQuery {
    entity_id: Option<Uuid>,
    #[serde(default)]
    offset: i64,
}

fn may_read(p: &Principal) -> Result<(), KernelError> {
    if p.branch_scope == BranchScope::All
        && [Feature::LegalEntityManage, Feature::OrgChangeApply]
            .into_iter()
            .any(|feature| authorize_capability(p, Action::new(feature)).is_ok())
    {
        Ok(())
    } else {
        Err(KernelError::forbidden(
            "identifier correction register requires organization-wide access",
        )
        .with_code("forbidden"))
    }
}

async fn list(
    State(state): State<EntityWiringState>,
    headers: HeaderMap,
    Query(query): Query<RegisterQuery>,
) -> Response {
    read(state, headers, query, None).await
}

async fn detail(
    State(state): State<EntityWiringState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Response {
    read(state, headers, RegisterQuery::default(), Some(id)).await
}

async fn read(
    state: EntityWiringState,
    headers: HeaderMap,
    query: RegisterQuery,
    id: Option<Uuid>,
) -> Response {
    let p = match principal(&state, &headers).await {
        Ok(p) => p,
        Err(error) => return error,
    };
    if let Err(error) = may_read(&p) {
        return decision_error(error);
    }
    if query.offset < 0 {
        return decision_error(
            KernelError::validation("invalid offset").with_code("validation_failed"),
        );
    }
    let result: Result<_, PgGovernanceError> =
        console_platform_db::with_org_conn(&state.pool, p.org_id, move |tx| {
            Box::pin(async move {
                let mut cases = register::list_conn(
                    tx.as_mut(),
                    query.entity_id,
                    id,
                    query.offset,
                    PAGE_SIZE + 1,
                )
                .await?;
                let more = cases.len() > PAGE_SIZE as usize;
                cases.truncate(PAGE_SIZE as usize);
                let mut items = Vec::with_capacity(cases.len());
                for case in cases {
                    let mut row = projection(&case, &p)?;
                    if let Some(id) = id {
                        let stored = get_exception_conn(tx.as_mut(), id)
                            .await?
                            .ok_or_else(|| KernelError::not_found("exception_not_found"))?;
                        let (contributed, holds) = decision_facts(tx, &stored, &p).await?;
                        let independent = stored.requested_by != p.user_id && !contributed && holds;
                        row["can_decide"] = json!(independent && row["status"] == "PENDING");
                        row["can_review"] = json!(
                            independent
                                && stored.status == ExceptionStatus::Recorded
                                && case.reviewed_at.is_none()
                        );
                    }
                    items.push(row);
                }
                if id.is_some() && items.is_empty() {
                    return Err(KernelError::not_found("exception_not_found").into());
                }
                Ok(json!({"items":items, "next_offset":more.then_some(query.offset + PAGE_SIZE)}))
            })
        })
        .await;
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => decision_error(governance_kernel(error)),
    }
}

fn projection(case: &CorrectionCase, p: &Principal) -> Result<Value, KernelError> {
    let mut row = serde_json::to_value(case)
        .map_err(|_| KernelError::internal("correction case serialization failed"))?;
    let expired = case.expires_at <= time::OffsetDateTime::now_utc()
        && case.consumed_at.is_none()
        && matches!(case.status.as_str(), "PENDING" | "APPROVED");
    row["status"] = json!(if expired {
        "EXPIRED"
    } else if case.consumed_at.is_some() && case.status == "APPROVED" {
        "APPLIED"
    } else {
        &case.status
    });
    row["can_apply"] = json!(
        !expired
            && case.status == "APPROVED"
            && case.consumed_at.is_none()
            && case.requested_by == *p.user_id.as_uuid()
            && case.proposal.is_some()
    );
    Ok(row)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReviewRequest {
    note: String,
}

async fn review(
    State(state): State<EntityWiringState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<ReviewRequest>,
) -> Response {
    let p = match principal(&state, &headers).await {
        Ok(p) => p,
        Err(error) => return error,
    };
    if body.note.trim().is_empty() || body.note.chars().count() > 1000 {
        return decision_error(
            KernelError::validation("review note is required and must fit the decision note")
                .with_code("validation_failed"),
        );
    }
    let result: Result<_, PgGovernanceError> = console_platform_db::with_audits(&state.pool, p.org_id, move |tx| Box::pin(async move {
        let reviewed = register::lock_review_conn(tx.as_mut(), id).await?;
        let stored = get_exception_conn(tx.as_mut(), id).await?
            .ok_or_else(|| KernelError::not_found("exception_not_found"))?;
        if stored.rule != RuleCode::EntityIdentifierCorrection { return Err(KernelError::forbidden("exception_rule_unsupported").into()); }
        if stored.status != ExceptionStatus::Recorded { return Err(KernelError::conflict("exception_not_recorded").with_code("exception_not_recorded").into()); }
        if stored.requested_by == p.user_id { return Err(KernelError::forbidden("exception_self_decision").into()); }
        let (contributed, holds) = decision_facts(tx, &stored, &p).await?;
        if contributed { return Err(KernelError::forbidden("exception_contributor_decision").into()); }
        enforce_action(&p, Feature::ExceptionDecide,
            AuthorizationResource::org_wide(p.org_id, "governed_exception").with_resource_id(id.to_string()),
            &Facts::new().bool("actor_is_requester", false).bool("actor_contributed", contributed)
                .bool("actor_holds_permission", holds).bool("step_up", false).bool("is_approval", false))?;
        let events = if reviewed { vec![] } else {
            vec![AuditEvent::new(Some(p.user_id), AuditAction::new("exception.review")?, "governed_exception", id.to_string(), TraceContext::generate(), time::OffsetDateTime::now_utc())
                .with_org(p.org_id).with_snapshots(None, Some(json!({"status":"REVIEWED", "note":body.note.trim(), "review_due_at":stored.review_due_at.map(|at| at.to_string())}))) ]
        };
        Ok((json!({"id":id,"status":"REVIEWED"}), events))
    })).await;
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => decision_error(governance_kernel(error)),
    }
}

pub(super) fn router() -> Router<EntityWiringState> {
    Router::new()
        .route("/api/v1/entity-identifier-corrections", get(list))
        .route("/api/v1/entity-identifier-corrections/{id}", get(detail))
        .route(
            "/api/v1/entity-identifier-corrections/{id}/review",
            post(review),
        )
}
