//! 근무 일정 routes (ATT S1). Reads need the directory read key, writes the
//! attendance edit key (`attendance::edit`), each on the branches it touches;
//! the adapter re-checks every target against the caller's scope.

mod handlers;
mod handlers_calendar;

use axum::extract::{FromRequest, Request};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use console_attendance_adapter_postgres::ScheduleStoreError;
use console_attendance_application::CallerScope;
use console_kernel_core::{BranchId, BranchScope, KernelError};
use console_platform_authz::{Action, Feature, Principal, authorize, authorize_org_wide};
use serde::de::DeserializeOwned;

use super::{AttendanceRestState, RestError};

pub const PATTERNS_PATH: &str = "/api/v1/attendance/patterns";
pub const PATTERN_RETIRE_PATH: &str = "/api/v1/attendance/patterns/{pattern_id}/retire";
pub const TREE_PATH: &str = "/api/v1/attendance/schedule/tree";
pub const CALENDAR_PATH: &str = "/api/v1/attendance/schedule/calendar";
pub const LAYERS_PATH: &str = "/api/v1/attendance/schedule/layers";
pub const LAYERS_PREVIEW_PATH: &str = "/api/v1/attendance/schedule/layers/preview";
pub const LAYER_CANCEL_PATH: &str = "/api/v1/attendance/schedule/layers/{layer_id}/cancel";
pub const CREWS_PATH: &str = "/api/v1/attendance/crews";
pub const CREW_MEMBERS_PATH: &str = "/api/v1/attendance/crews/{crew_id}/members";
pub const HOLIDAYS_PATH: &str = "/api/v1/attendance/holidays";
pub const HOLIDAYS_PREVIEW_PATH: &str = "/api/v1/attendance/holidays/preview";
pub const HOLIDAY_RETIRE_PATH: &str = "/api/v1/attendance/holidays/{holiday_id}/retire";
pub const ME_SCHEDULE_PATH: &str = "/api/v1/attendance/me/schedule";

pub(crate) fn router() -> Router<AttendanceRestState> {
    use handlers as h;
    use handlers_calendar as hc;
    Router::new()
        .route(PATTERNS_PATH, get(h::list_patterns).post(h::create_pattern))
        .route(PATTERN_RETIRE_PATH, post(h::retire_pattern))
        .route(TREE_PATH, get(h::tree))
        .route(CALENDAR_PATH, get(h::calendar))
        .route(LAYERS_PATH, get(h::list_layers).post(h::assign))
        .route(LAYERS_PREVIEW_PATH, post(h::preview))
        .route(LAYER_CANCEL_PATH, post(h::cancel))
        .route(CREWS_PATH, get(hc::list_crews).post(hc::create_crew))
        .route(CREW_MEMBERS_PATH, post(hc::place_members))
        .route(HOLIDAYS_PATH, get(hc::holidays).post(hc::create_holiday))
        .route(HOLIDAYS_PREVIEW_PATH, post(hc::preview_holiday))
        .route(HOLIDAY_RETIRE_PATH, post(hc::retire_holiday))
        .route(ME_SCHEDULE_PATH, get(hc::me))
}

pub(crate) const READ: Feature = Feature::EmployeeDirectoryRead;
pub(crate) const WRITE: Feature = Feature::AttendanceExceptionManage;

/// The caller's scope for `feature`: the whole tenant when the grant is
/// org-wide, else only the branches the feature is granted on. No branch is a
/// truthful 403.
pub(crate) fn caller(p: &Principal, feature: Feature) -> Result<CallerScope, RestError> {
    let (org_id, user_id) = (*p.org_id.as_uuid(), *p.user_id.as_uuid());
    if authorize_org_wide(p, Action::new(feature)).is_ok() {
        return Ok(CallerScope {
            org_id,
            user_id,
            branch_ids: vec![],
            org_wide: true,
        });
    }
    let branch_ids: Vec<_> = match &p.branch_scope {
        BranchScope::Branches(set) => set
            .iter()
            .filter(|b| authorize(p, Action::new(feature), **b).is_ok())
            .map(|b: &BranchId| *b.as_uuid())
            .collect(),
        BranchScope::All => vec![],
    };
    if branch_ids.is_empty() {
        return Err(RestError::kernel(KernelError::forbidden(
            "attendance access is not granted",
        )));
    }
    Ok(CallerScope {
        org_id,
        user_id,
        branch_ids,
        org_wide: false,
    })
}

impl RestError {
    pub(crate) fn schedule(e: ScheduleStoreError) -> Self {
        use ScheduleStoreError as E;
        match e {
            E::Refused(r) => {
                let status = if r.is_conflict() {
                    StatusCode::CONFLICT
                } else {
                    StatusCode::UNPROCESSABLE_ENTITY
                };
                Self::new(status, r.code(), r.to_string())
            }
            E::Conflict(code) => Self::new(StatusCode::CONFLICT, code, code),
            E::Invalid(code) => Self::new(StatusCode::UNPROCESSABLE_ENTITY, code, code),
            E::NotFound(code) => Self::new(StatusCode::NOT_FOUND, code, code),
            // The rows ride only through `records::refused`; here the code alone.
            E::EntryConflict(_) => {
                Self::new(StatusCode::CONFLICT, "entry_conflict", "entry_conflict")
            }
            E::CellsRefused(_) => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "cells_refused",
                "cells_refused",
            ),
            E::Forbidden => Self::kernel(KernelError::forbidden(
                "the scope is outside your attendance access",
            )),
            E::Corrupt(_) | E::Database(_) | E::Sql(_) => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "attendance schedule request failed",
            ),
        }
    }
}

/// A JSON body whose rejection is a 422 with a stable code.
pub(crate) struct Body<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequest<S> for Body<T> {
    type Rejection = RestError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        Json::<T>::from_request(req, state)
            .await
            .map(|Json(v)| Self(v))
            .map_err(|r| {
                RestError::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "body_invalid",
                    r.body_text(),
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use console_attendance_domain::schedule::ScheduleRefusal;

    #[test]
    fn store_refusals_keep_their_code_and_status() {
        let cases = [
            (
                ScheduleStoreError::Refused(ScheduleRefusal::LayerInEffect),
                StatusCode::CONFLICT,
                "schedule_layer_in_effect",
            ),
            (
                ScheduleStoreError::Refused(ScheduleRefusal::BreakBelowMinimum),
                StatusCode::UNPROCESSABLE_ENTITY,
                "break_below_minimum",
            ),
            (
                ScheduleStoreError::Conflict("pattern_name_taken"),
                StatusCode::CONFLICT,
                "pattern_name_taken",
            ),
            (
                ScheduleStoreError::Invalid("holiday_rule_invalid"),
                StatusCode::UNPROCESSABLE_ENTITY,
                "holiday_rule_invalid",
            ),
            (
                ScheduleStoreError::NotFound("scope_not_found"),
                StatusCode::NOT_FOUND,
                "scope_not_found",
            ),
            (
                ScheduleStoreError::Forbidden,
                StatusCode::FORBIDDEN,
                "forbidden",
            ),
            (
                ScheduleStoreError::Corrupt("spec"),
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
            ),
        ];
        for (e, status, code) in cases {
            let r = RestError::schedule(e);
            assert_eq!((r.status, r.code), (status, code));
        }
    }

    #[test]
    fn every_schedule_path_is_mounted_once() {
        let paths = [
            PATTERNS_PATH,
            PATTERN_RETIRE_PATH,
            TREE_PATH,
            CALENDAR_PATH,
            LAYERS_PATH,
            LAYERS_PREVIEW_PATH,
            LAYER_CANCEL_PATH,
            CREWS_PATH,
            CREW_MEMBERS_PATH,
            HOLIDAYS_PATH,
            HOLIDAYS_PREVIEW_PATH,
            HOLIDAY_RETIRE_PATH,
            ME_SCHEDULE_PATH,
        ];
        for p in paths {
            assert_eq!(
                crate::ATTENDANCE_ROUTE_PATHS
                    .iter()
                    .filter(|x| **x == p)
                    .count(),
                1,
                "{p}"
            );
        }
    }
}
