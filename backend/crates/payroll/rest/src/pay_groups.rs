// SPDX-License-Identifier: LicenseRef-Proprietary
//! HTTP boundary; the store owns Cedar, validation and audit in one transaction.
#[path = "run_preview.rs"]
mod run_preview;
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use console_payroll_adapter_postgres::pay_groups::{CreatePayGroup, PayGroup, PayGroupPage};
use console_platform_authz::{Feature, Principal, cedar_pbac::visible};
use console_platform_db::{command_outcomes::CommandOutcome, with_org_conn};
use console_platform_request_context::record_access::{self, outcome::ReadFuture};
pub(crate) use run_preview::{create as create_run, preview};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{PayrollRestState, RestError, principal_from_headers};

pub const PAYROLL_PAY_GROUPS_PATH: &str = "/api/v1/payroll/pay-groups";

pub(crate) fn router() -> Router<PayrollRestState> {
    Router::new()
        .route(PAYROLL_PAY_GROUPS_PATH, get(list).post(create))
        .route(crate::PAYROLL_RUNS_PATH, post(create_run))
}

pub(crate) fn with_replay_context(
    router: Router,
    verifier: Option<console_platform_auth::JwtVerifier>,
    pool: PgPool,
) -> Router {
    console_platform_request_context::with_request_context(router, verifier, pool).layer(
        axum::Extension(record_access::outcome::Reader(read_outcome)),
    )
}

fn read_outcome<'a>(
    pool: &'a PgPool,
    principal: &'a Principal,
    outcome: &'a mut CommandOutcome,
) -> ReadFuture<'a> {
    Box::pin(async move {
        let Some(id) = outcome
            .result
            .as_ref()
            .and_then(|result| result["id"].as_str())
            .and_then(|id| Uuid::parse_str(id).ok())
        else {
            return record_access::all_readable(pool, principal, &outcome.touched).await;
        };
        let (target_type, pay_group_id) = match outcome.command.as_str() {
            command if command == format!("POST {PAYROLL_PAY_GROUPS_PATH}") => {
                ("pay_group", Some(id))
            }
            command if command == format!("POST {}", crate::PAYROLL_RUNS_PATH) => (
                "payroll_draft_run",
                outcome
                    .result
                    .as_ref()
                    .and_then(|result| result["pay_group_id"].as_str())
                    .and_then(|id| Uuid::parse_str(id).ok()),
            ),
            _ => return record_access::all_readable(pool, principal, &outcome.touched).await,
        };
        let Some(pay_group_id) = pay_group_id else {
            return false;
        };
        if !outcome.touched.as_array().is_some_and(|items| {
            items.len() == 1 && items[0]["type"] == target_type && items[0]["id"] == id.to_string()
        }) {
            return false;
        }
        let (org, actor) = (principal.org_id, principal.user_id);
        let store = console_payroll_adapter_postgres::PgPayrollStore::new(pool.clone());
        let readable = with_org_conn::<_, _, console_payroll_adapter_postgres::PgPayrollError>(
            pool,
            org,
            move |tx| {
                Box::pin(async move {
                    visible::require_payroll_module(tx, org, *actor.as_uuid(), &store).await?;
                    let facts = visible::load_facts(tx, org, *actor.as_uuid()).await?;
                    Ok(facts
                        .visible_pay_groups(tx, Feature::PayrollRunManage, &store)
                        .await?
                        .contains(&pay_group_id))
                })
            },
        )
        .await
        .unwrap_or(false);
        console_platform_authz::cedar_pbac::actions::command_outcome::decide(
            &actor.to_string(),
            &org.to_string(),
            false,
            readable,
        )
        .unwrap_or(false)
    })
}

async fn list(
    State(state): State<PayrollRestState>,
    headers: HeaderMap,
) -> Result<Json<PayGroupPage>, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let page = state
        .store
        .list_pay_groups(principal.org_id, principal.user_id)
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(page))
}

async fn create(
    State(state): State<PayrollRestState>,
    headers: HeaderMap,
    body: Result<Json<CreatePayGroup>, axum::extract::rejection::JsonRejection>,
) -> Result<(StatusCode, Json<PayGroup>), RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let Json(input) = body.map_err(|_| {
        RestError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation",
            "all pay-group choices must be explicitly supplied with valid types",
        )
    })?;
    let group = state
        .store
        .create_pay_group(principal.org_id, principal.user_id, input)
        .await
        .map_err(RestError::from_store)?;
    Ok((StatusCode::CREATED, Json(group)))
}
