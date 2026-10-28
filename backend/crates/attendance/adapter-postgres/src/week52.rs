// SPDX-License-Identifier: LicenseRef-Proprietary
//! One register/settings snapshot for both weekly read projections.
use std::collections::BTreeMap;

use console_attendance_application::{
    self as app, Week52Limits, Week52Read, week52::WARN_HOURS_KEY,
};
use console_kernel_core::OrgId;
use console_platform_db::{
    settings_read::resolve_in_tx,
    statutory_read::{StatutoryUnit, codes, load_statutory_register},
};
use sqlx::PgConnection;
use time::{Date, OffsetDateTime};
use uuid::Uuid;

use crate::AttendanceStoreError;

pub(crate) async fn load_limits(
    conn: &mut PgConnection,
    org: OrgId,
    on: Date,
) -> Result<Option<Week52Limits>, AttendanceStoreError> {
    let register = load_statutory_register(conn)
        .await
        .map_err(|_| AttendanceStoreError::Conflict)?;
    let (Ok(standard), Ok(overtime)) = (
        register.rule(codes::WEEKLY_STANDARD_HOURS, on),
        register.rule(codes::WEEKLY_OVERTIME_MAX_HOURS, on),
    ) else {
        return Ok(None);
    };
    let standard = standard
        .whole(StatutoryUnit::HoursPerWeek)
        .map_err(|_| AttendanceStoreError::Conflict)?;
    let overtime = overtime
        .whole(StatutoryUnit::HoursPerWeek)
        .map_err(|_| AttendanceStoreError::Conflict)?;
    let settings = resolve_in_tx(
        conn,
        org,
        &[WARN_HOURS_KEY],
        None,
        OffsetDateTime::now_utc(),
    )
    .await
    .map_err(|_| AttendanceStoreError::Conflict)?;
    let warn = settings
        .get(&WARN_HOURS_KEY)
        .and_then(|value| value.as_ref().ok())
        .and_then(|value| value.value.as_int())
        .ok_or(AttendanceStoreError::Conflict)?;
    let danger = standard
        .checked_add(overtime)
        .ok_or(AttendanceStoreError::Conflict)?;
    if standard <= 0 || warn < standard || warn >= danger {
        return Ok(None);
    }
    Ok(Some(Week52Limits {
        danger_hours: danger as f64,
        warn_hours: warn as f64,
    }))
}

pub(super) fn week52_inputs_for_active(
    active_employees: impl IntoIterator<Item = (Uuid, String, Option<String>)>,
    week_start: Date,
    hours: BTreeMap<Uuid, f64>,
    acknowledgements: BTreeMap<Uuid, OffsetDateTime>,
    limits: Option<app::Week52Limits>,
) -> Vec<Week52Read> {
    active_employees
        .into_iter()
        .map(|(employee_id, name, team)| {
            let current_hours = hours.get(&employee_id).copied().unwrap_or(0.0);
            Week52Read {
                employee_id,
                name,
                team,
                week_start,
                current_hours,
                projected_hours: current_hours,
                tone: limits.map_or(app::Week52Tone::Unknown, |limits| {
                    app::week52_tone(
                        &app::Week52Input {
                            employee_id,
                            week_start,
                            current_hours,
                            projected_hours: current_hours,
                            acknowledged_at: acknowledgements.get(&employee_id).copied(),
                        },
                        limits,
                    )
                }),
                acknowledged_at: acknowledgements.get(&employee_id).copied(),
            }
        })
        .collect()
}
