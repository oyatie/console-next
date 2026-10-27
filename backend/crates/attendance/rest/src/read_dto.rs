// SPDX-License-Identifier: LicenseRef-Proprietary
//! Personal attendance read projections shared by the REST handlers.
use console_attendance_application::{SubstitutionCandidateRead, Week52Read, week52_tone};
use serde::Serialize;

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
    tone: String,
    acked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    acked_at: Option<String>,
}
impl From<Week52Read> for Week52RowDto {
    fn from(v: Week52Read) -> Self {
        let tone = week52_tone(&console_attendance_application::Week52Input {
            employee_id: v.employee_id,
            week_start: v.week_start,
            current_hours: v.current_hours,
            projected_hours: v.projected_hours,
            acknowledged_at: v.acknowledged_at,
        });
        Self {
            employee_id: v.employee_id.to_string(),
            name: v.name,
            team: v.team,
            week_start: v.week_start.to_string(),
            current_hours: v.current_hours,
            projected_hours: v.projected_hours,
            tone: match tone {
                console_attendance_application::Week52Tone::Ok => "OK",
                console_attendance_application::Week52Tone::Warn => "WARN",
                console_attendance_application::Week52Tone::Danger => "DANGER",
            }
            .into(),
            acked: v.acknowledged_at.is_some(),
            acked_at: v.acknowledged_at.map(|d| {
                d.format(&time::format_description::well_known::Rfc3339)
                    .unwrap_or_else(|_| d.to_string())
            }),
        }
    }
}
#[derive(Serialize)]
pub(super) struct Week52BoardDto {
    pub(super) week_start: String,
    pub(super) items: Vec<Week52RowDto>,
}
