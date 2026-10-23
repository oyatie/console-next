//! BW-11 record guards, checked after preparation (the employee row is locked):
//! no silent supersede, the version pins, and the hire-date floor.

use console_hr_domain::text::parse_yyyy_mm_dd;
use console_kernel_core::{KernelError, OrgId};
use console_settings_domain::code_lists::ReasonDomain;
use http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::OffsetDateTime;
use uuid::Uuid;

use super::prepare::PreparedLifecycleEvent;
use super::title_reason::{coded, validate_reason_code};
use crate::HrError;

/// The request's pins and its explicit replacement, if any.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct RecordGuards {
    /// The `head_version` the client read (`GET …/lifecycle-events`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_head_version: Option<i32>,
    /// CONTRACT_RENEWAL: the contract end the client saw.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_contract_end_date: Option<String>,
    /// The SCHEDULED event of the same kind and date this one replaces.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replaces_event_id: Option<Uuid>,
    /// `lifecycle_cancel` code recorded on the replaced event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replace_reason_code: Option<String>,
}

fn refused(status: StatusCode, code: &'static str, message: String, detail: Value) -> HrError {
    HrError {
        errors: None,
        status,
        code,
        message,
        refusals: Some(Box::new(Value::Array(vec![detail]))),
    }
}

/// 409 `stale_record`, naming the last change the client did not see.
async fn stale(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: Uuid,
    employee: Uuid,
) -> Result<HrError, HrError> {
    let last: Option<(Uuid, String, String, Option<String>, OffsetDateTime)> = sqlx::query_as(
        "SELECT l.id, l.event_type, l.effective_date, u.display_name, l.created_at \
         FROM employee_lifecycle_events l LEFT JOIN person_accounts_current u ON u.id = l.created_by \
         WHERE l.org_id = $1 AND l.employee_id = $2 AND l.state = 'APPLIED' \
         ORDER BY l.created_at DESC, l.id DESC LIMIT 1",
    )
    .bind(org)
    .bind(employee)
    .fetch_optional(tx.as_mut())
    .await?;
    let detail = last.map_or(Value::Null, |(id, kind, on, by, at)| {
        json!({ "lifecycle_event_id": id, "event_type": kind, "effective_date": on,
                "recorded_by": by, "recorded_at": at.to_string() })
    });
    Ok(refused(
        StatusCode::CONFLICT,
        "stale_record",
        "the employee changed since it was read; reload before retrying".to_owned(),
        detail,
    ))
}

pub async fn check_record_guards(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: OrgId,
    employee: Uuid,
    prepared: &mut PreparedLifecycleEvent,
    guards: &RecordGuards,
) -> Result<(), HrError> {
    let org_uuid = *org.as_uuid();
    let (hire, version, contract_end): (Option<String>, i32, Option<String>) = sqlx::query_as(
        "SELECT e.hire_date, e.head_version, p.contract_end_date::TEXT \
         FROM person_employees_current e LEFT JOIN employee_employment_profiles p \
           ON p.org_id = e.org_id AND p.employee_id = e.id \
         WHERE e.org_id = $1 AND e.id = $2",
    )
    .bind(org_uuid)
    .bind(employee)
    .fetch_one(tx.as_mut())
    .await?;
    let transition = &prepared.transition;
    let effective = parse_yyyy_mm_dd(&transition.effective_date)?;
    // An imported hire date that does not parse sets no floor.
    if let Some(hire) = hire.as_deref().and_then(|d| parse_yyyy_mm_dd(d).ok())
        && effective < hire
    {
        return Err(coded(
            KernelError::validation(format!(
                "effective_date must be on or after the hire date {hire}"
            ))
            .with_code("effective_date_before_hire")
            .with_field("effective_date"),
        ));
    }
    let pinned_end = guards.expected_contract_end_date.as_deref().map(str::trim);
    if guards.expected_head_version.is_some_and(|v| v != version)
        || (transition.event_type == "CONTRACT_RENEWAL"
            && pinned_end.is_some()
            && pinned_end != contract_end.as_deref())
    {
        return Err(stale(tx, org_uuid, employee).await?);
    }
    match (prepared.replaces, guards.replaces_event_id) {
        (None, None) => Ok(()),
        (Some(existing), named) if named != Some(existing) => {
            let (kind, on, by): (String, String, Option<String>) = sqlx::query_as(
                "SELECT l.event_type, l.effective_date, u.display_name \
                 FROM employee_lifecycle_events l LEFT JOIN person_accounts_current u ON u.id = l.created_by \
                 WHERE l.org_id = $1 AND l.id = $2",
            )
            .bind(org_uuid)
            .bind(existing)
            .fetch_one(tx.as_mut())
            .await?;
            Err(refused(
                StatusCode::CONFLICT,
                "scheduled_conflict",
                format!(
                    "a {kind} is already scheduled for {on}; replace it explicitly or change the date"
                ),
                json!({ "event_id": existing, "event_type": kind, "effective_date": on, "recorded_by": by }),
            ))
        }
        (None, Some(_)) => Err(coded(
            KernelError::conflict(
                "replaces_event_id names no SCHEDULED event of this kind and date",
            )
            .with_code("scheduled_replace_mismatch")
            .with_field("replaces_event_id"),
        )),
        // The named event is the one this replaces.
        (Some(_), _) => {
            let code = guards
                .replace_reason_code
                .as_deref()
                .map(str::trim)
                .unwrap_or_default();
            if code.is_empty() {
                return Err(coded(
                    KernelError::validation(
                        "replace_reason_code is required to replace a scheduled event",
                    )
                    .with_code("reason_code_required")
                    .with_field("replace_reason_code"),
                ));
            }
            validate_reason_code(tx, org, ReasonDomain::LifecycleCancel, code, None).await?;
            prepared.replace_reason_code = Some(code.to_owned());
            Ok(())
        }
    }
}
