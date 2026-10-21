//! UX-R2 ENDS: the 사업장 close job (company-01, worst-case-18). One plan
//! closes a 사업장 that still has people and 부서: a line for every person
//! (전근 | 퇴직) and every 부서 directly under it (moved | 폐지), applied
//! all-or-none on the 폐쇄일 (HR's `lifecycle::close_plan`).
//!
//! Who may: `legal_entity_manage` on the 사업장 (the close) AND
//! `employee_directory_manage` (each 전근, 퇴직 and 전적 is an HR write), both
//! evaluated, either missing refuses (403, nothing written); HR checks each
//! 전적's receiving place against the planner's grants as a single 전적.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use console_entity_application::Target;
use console_hr_adapter_postgres::lifecycle::close_plan::Planner;
use console_hr_adapter_postgres::lifecycle::close_plan::types::WorkplaceClosePlanRequest;
use console_hr_adapter_postgres::{HrError, HrService};
use serde_json::json;
use uuid::Uuid;

use crate::EntityRestState;
use crate::auth::{Need, actor, manager, principal};
use crate::error::RestError;
use crate::org_setup::port;

type Result<T> = std::result::Result<T, RestError>;

pub(crate) async fn read(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let (a, _) = actor(&s, &h, Need::People, Target::Workplace(id)).await?;
    Ok(match hr(&s).workplace_close_plan(a.org, id).await {
        Ok(view) => Json(view).into_response(),
        Err(e) => hr_error(e),
    })
}

pub(crate) async fn plan(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<WorkplaceClosePlanRequest>,
) -> Result<Response> {
    let who = planner(&s, &h, id).await?;
    Ok(
        match hr(&s).plan_workplace_close(who, id, body, port(&s)?).await {
            Ok(job) => Json(job).into_response(),
            Err(e) => hr_error(e),
        },
    )
}

pub(crate) async fn cancel(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let who = planner(&s, &h, id).await?;
    Ok(match hr(&s).cancel_workplace_close(who, id).await {
        Ok(job) => Json(job).into_response(),
        Err(e) => hr_error(e),
    })
}

/// Both permissions, each refusing on its own; the command id is the key.
async fn planner(s: &EntityRestState, h: &HeaderMap, id: Uuid) -> Result<Planner> {
    let a = manager(s, h, Target::Workplace(id)).await?;
    actor(s, h, Need::People, Target::Workplace(id)).await?;
    let command = a
        .command_id
        .ok_or_else(|| console_entity_domain::Refusal::field("Idempotency-Key", "required"))?;
    Ok(Planner {
        org: a.org,
        user: a.user,
        command,
        principal: principal(s, h).await?,
    })
}

fn hr(s: &EntityRestState) -> HrService {
    HrService::new(s.store.pool().clone())
}

/// The HR face's envelope: `{"error": {code, message, refusals?}}`; a fault
/// is logged and answered generically.
fn hr_error(e: HrError) -> Response {
    let message = if e.status.is_server_error() {
        tracing::error!(code = e.code, error = %e.message, "workplace close plan fault");
        "internal server error".to_owned()
    } else {
        e.message
    };
    let mut error = json!({ "code": e.code, "message": message });
    if let Some(refusals) = e.refusals {
        error["refusals"] = refusals;
    }
    (e.status, Json(json!({ "error": error }))).into_response()
}
