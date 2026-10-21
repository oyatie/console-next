//! IMPORT-2 (decisions #26): the current status a file records for a new
//! person — 재직, 휴직 (with its start date and type), 퇴사, 입사 예정 — as a
//! setup fact. A stated status must agree with the dates; a text the catalog
//! and the operator's map do not know is a question, never a guess.

use super::cells::parse_import_date;
use super::normalize::{known_code, leave_type_code, status_code};
use super::plan::{Decisions, ImportRow, PlanFacts, SetupLeave};

/// A refusal as `(code, field)`; the planner turns it into the plan row.
pub(super) type Refusal = (&'static str, &'static str);

const UNMAPPED: Refusal = ("status_unmapped", "employment_status");

/// The row's stated status code, `Ok(None)` when it states none.
///
/// # Errors
/// `status_unmapped` when the text maps to no status.
pub(super) fn status_of(
    row: &ImportRow,
    decisions: &Decisions,
) -> Result<Option<&'static str>, Refusal> {
    let Some(text) = row.status.as_deref() else {
        return Ok(None);
    };
    status_code(text)
        .or_else(|| {
            decisions
                .status_map
                .get(text)
                .and_then(|code| known_code("status", code))
        })
        .map(Some)
        .ok_or(UNMAPPED)
}

fn leave(row: &ImportRow, hire: time::Date, decisions: &Decisions) -> Result<SetupLeave, Refusal> {
    let raw = row
        .leave_start_date
        .as_deref()
        .ok_or(("leave_start_required", "leave_start_date"))?;
    let start = parse_import_date(raw)
        .filter(|start| *start >= hire)
        .ok_or(("invalid_date", "leave_start_date"))?;
    let text = row.leave_type.as_deref().unwrap_or("");
    let leave_type = leave_type_code(text)
        .or_else(|| {
            decisions
                .leave_type_map
                .get(text)
                .and_then(|code| known_code("leave_type", code))
        })
        .ok_or(("leave_type_unmapped", "leave_type"))?;
    let back = match row.leave_return_date.as_deref() {
        Some(raw) => Some(
            parse_import_date(raw)
                .filter(|back| *back > start)
                .ok_or(("invalid_date", "leave_return_date"))?,
        ),
        // 0264: 육아휴직 and 출산전후휴가 name their return date.
        None if matches!(leave_type, "CHILDCARE" | "MATERNITY") => {
            return Err(("leave_return_required", "leave_return_date"));
        }
        None => None,
    };
    Ok(SetupLeave {
        start_date: start.to_string(),
        leave_type,
        expected_return_date: back.map(|d| d.to_string()),
    })
}

/// A new person's status (and 휴직), from the stated status and the dates.
///
/// # Errors
/// A status the dates contradict, a 퇴사 without 퇴사일, a 휴직 without its
/// start or type, a former employee after the first payroll.
pub(super) fn new_status(
    row: &ImportRow,
    (hire, exit): (time::Date, Option<time::Date>),
    facts: &PlanFacts<'_>,
    decisions: &Decisions,
) -> Result<(&'static str, Option<SetupLeave>), Refusal> {
    const CONFLICT: Refusal = ("status_conflict", "employment_status");
    if exit.is_some_and(|exit| exit < hire) {
        return Err(("invalid_date", "exit_date"));
    }
    let future = hire > facts.today;
    let status = match (status_of(row, decisions)?, exit) {
        (None | Some("EXITED"), Some(_)) => "EXITED",
        (Some("EXITED"), None) => return Err(("exit_date_required", "exit_date")),
        (Some(_), Some(_)) => return Err(CONFLICT),
        (None, None) if future => "PRE_HIRE",
        (None, None) => "ACTIVE",
        (Some("PRE_HIRE"), None) if future => "PRE_HIRE",
        (Some(status @ ("ACTIVE" | "ON_LEAVE")), None) if !future => status,
        // r3:hire-19: 재직 with a future 입사일, answered 「입사 예정으로」.
        (Some("ACTIVE"), None)
            if decisions
                .group_answers
                .get("status_conflict")
                .map(String::as_str)
                == Some("pre_hire") =>
        {
            "PRE_HIRE"
        }
        (Some(_), None) => return Err(CONFLICT),
    };
    if status == "EXITED" && !facts.former_load_open {
        return Err(("former_load_closed", "exit_date"));
    }
    let setup_leave = match status {
        "ON_LEAVE" => Some(leave(row, hire, decisions)?),
        _ => None,
    };
    Ok((status, setup_leave))
}
