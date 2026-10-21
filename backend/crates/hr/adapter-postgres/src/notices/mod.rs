//! 발령 공고 · 발령 번호 (EMP-UI 10, spec E5-notice): an announcement of
//! recorded lifecycle events with a number the server assigns (YYYY-NNNN per
//! tenant and notice year, gapless at issue, never reused). Issued once,
//! never rewritten; a 발령 is on one notice at most. The FE draws the 공고
//! from the read (no server-side PDF). No approval step (#26).
//!
//! Gates: issue needs `employee_directory_manage` org-wide (the lifecycle
//! writers' gate); reads need `employee_directory_read` org-wide, and a
//! reader without manage sees each event as the lifecycle history redacts it.

mod issue;
mod read;

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::lifecycle::types::EmployeeLifecycleEventResponse;

pub use crate::lifecycle::events_page::LifecycleEventsQuery as AppointmentNoticeListQuery;

/// The most events one notice announces (`appointment_notice_lines` CHECK).
pub const MAX_NOTICE_LINES: usize = 500;

/// Body of `POST /api/v1/appointment-notices`: exactly one of `event_ids`
/// (printed in that order) or `batch_id` (a bulk 발령, in employee order).
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct IssueAppointmentNoticeRequest {
    pub title: String,
    pub notice_date: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub event_ids: Vec<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppointmentNoticeSummary {
    pub id: Uuid,
    /// 발령 번호, YYYY-NNNN.
    pub notice_no: String,
    pub title: String,
    pub notice_date: String,
    pub issued_by: Uuid,
    pub issued_by_name: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub issued_at: OffsetDateTime,
    pub line_count: i64,
}

#[derive(Debug, Serialize)]
pub struct AppointmentNoticeLine {
    pub line_no: i32,
    pub employee_id: Uuid,
    pub employee_number: Option<String>,
    pub name: String,
    pub event: EmployeeLifecycleEventResponse,
}

#[derive(Debug, Serialize)]
pub struct AppointmentNotice {
    #[serde(flatten)]
    pub summary: AppointmentNoticeSummary,
    pub note: Option<String>,
    pub lines: Vec<AppointmentNoticeLine>,
}

#[derive(Debug, Serialize)]
pub struct AppointmentNoticePage {
    pub items: Vec<AppointmentNoticeSummary>,
    pub next_cursor: Option<String>,
}
