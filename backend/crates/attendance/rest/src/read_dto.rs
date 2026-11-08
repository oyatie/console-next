// SPDX-License-Identifier: LicenseRef-Proprietary
//! Personal attendance read projections shared by the REST handlers.
use console_attendance_application::{SubstitutionCandidateRead, Week52Read};
use serde::Serialize;
use time::{OffsetDateTime, UtcOffset};

#[derive(Serialize)]
pub(super) struct SubstitutionCandidateDto {
    employee_id: String,
    employee_name: String,
    branch_id: String,
}

impl From<SubstitutionCandidateRead> for SubstitutionCandidateDto {
    fn from(value: SubstitutionCandidateRead) -> Self {
        Self {
            employee_id: value.employee_id.to_string(),
            employee_name: value.employee_name,
            branch_id: value.branch_id.to_string(),
        }
    }
}

#[derive(Serialize)]
pub(super) struct Week52RowDto {
    employee_id: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    team: Option<String>,
    week_start: String,
    current_hours: f64,
    projected_hours: f64,
    recognized_hours: Option<f64>,
    overtime_hours: Option<f64>,
    tone: String,
    acked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(with = "time::serde::rfc3339::option")]
    acked_at: Option<OffsetDateTime>,
}
impl From<Week52Read> for Week52RowDto {
    fn from(v: Week52Read) -> Self {
        Self {
            employee_id: v.employee_id.to_string(),
            name: v.name,
            team: v.team,
            week_start: v.week_start.to_string(),
            current_hours: v.current_hours,
            projected_hours: v.projected_hours,
            recognized_hours: v.recognized_hours,
            overtime_hours: v.overtime_hours,
            tone: match v.tone {
                console_attendance_application::Week52Tone::Ok => "OK",
                console_attendance_application::Week52Tone::Warn => "WARN",
                console_attendance_application::Week52Tone::Danger => "DANGER",
                console_attendance_application::Week52Tone::Unknown => "UNKNOWN",
            }
            .into(),
            acked: v.acknowledged_at.is_some(),
            acked_at: v.acknowledged_at.map(|at| at.to_offset(UtcOffset::UTC)),
        }
    }
}
#[derive(Serialize)]
pub(super) struct Week52BoardDto {
    pub(super) week_start: String,
    pub(super) items: Vec<Week52RowDto>,
}
