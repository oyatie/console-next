use super::types::{FilingTask, LossOption};
use crate::{HrError, clock::today_kst};
use console_compliance_domain::statutory::filing::Reason;
use console_compliance_domain::statutory::{Insurer, StatutoryRegister};
use console_hr_domain::text::parse_yyyy_mm_dd;
use sqlx::{Row, postgres::PgRow};

pub(super) fn task(
    row: PgRow,
    register: &StatutoryRegister,
    as_of: Option<time::OffsetDateTime>,
) -> Result<Option<FilingTask>, HrError> {
    let insurer: String = row.try_get("insurer")?;
    let kind: String = row.try_get("kind")?;
    let mut effective_date: String = row.try_get("effective_date")?;
    let on = parse_yyyy_mm_dd(&effective_date)?;
    let is_request = row
        .try_get::<Option<uuid::Uuid>, _>("source_event_id")?
        .is_some();
    let Some(assessment) = console_hr_application::statutory::assess(
        console_hr_application::statutory::FilingInput {
            kind: &kind,
            insurer: &insurer,
            on,
            acquired_on: row
                .try_get::<Option<String>, _>("acquired_on")?
                .as_deref()
                .map(parse_yyyy_mm_dd)
                .transpose()?,
            ended_on: row
                .try_get::<Option<String>, _>("ended_on")?
                .as_deref()
                .map(parse_yyyy_mm_dd)
                .transpose()?,
            requested_acquisition_on: row
                .try_get::<Option<String>, _>("requested_acquisition_on")?
                .as_deref()
                .map(parse_yyyy_mm_dd)
                .transpose()?,
            today: as_of
                .map(|t| t.to_offset(time::macros::offset!(+9)).date())
                .unwrap_or_else(today_kst),
            facts: row
                .try_get::<Option<serde_json::Value>, _>("applicability_facts")?
                .map(serde_json::from_value)
                .transpose()
                .map_err(|_| HrError::internal("invalid stored filing facts"))?
                .unwrap_or_default(),
            birth_date: row.try_get("birth_date")?,
            employment_type: row.try_get("employment_type")?,
            nationality: row.try_get("nationality")?,
            action: row.try_get("action")?,
            employment_filed: row.try_get::<Option<String>, _>("ei_action")?.as_deref()
                == Some("COMPLETE"),
            request: is_request,
        },
        register,
    )?
    else {
        return Ok(None);
    };
    let on = assessment.on;
    let source_created: time::OffsetDateTime = row.try_get("created_at")?;
    let created_at = if kind == "AGE60" {
        source_created.max(on.midnight().assume_offset(time::macros::offset!(+9)))
    } else {
        source_created
    };
    effective_date = on.to_string();
    let dates = assessment.dates;
    let rule = assessment.rule;
    let due_date = dates.as_ref().and_then(|d| d.due_on.clone());
    let due_in_days = due_date
        .as_deref()
        .map(parse_yyyy_mm_dd)
        .transpose()?
        .map(|d| (d - today_kst()).whole_days());
    let not_applicable_reason: Option<Reason> = row
        .try_get::<Option<String>, _>("not_applicable_reason")?
        .map(|s| serde_json::from_value(serde_json::Value::String(s)))
        .transpose()
        .map_err(|_| HrError::internal("invalid stored filing reason"))?;
    let policy_on = if matches!(kind.as_str(), "LOSE" | "AGE60") {
        rule.as_ref()
            .map(|r| r.loss_on(on))
            .transpose()?
            .unwrap_or(on)
    } else {
        on
    };
    let loss_options = if kind == "LOSE" || kind == "AGE60" {
        Insurer::from_db_str(&insurer)
            .ok()
            .map(|insurer| {
                register
                    .loss_codes_on(insurer, policy_on)
                    .map(|c| LossOption {
                        code: c.code.clone(),
                        label: c.label_ko.clone(),
                        requires_detail: c.requires_detail,
                        held: c.disposition.is_hold(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    Ok(Some(FilingTask {
        created_at,
        event_id: row.try_get("id")?,
        employee_id: row.try_get("employee_id")?,
        name: row.try_get("name")?,
        employee_number: row.try_get("employee_number")?,
        kind: kind.clone(),
        insurer,
        effective_date,
        legal_entity_id: row.try_get("legal_entity_id")?,
        workplace_id: row.try_get("workplace_id")?,
        workplace_name: row.try_get("workplace_name")?,
        due_date: due_date.clone(),
        due_in_days,
        deadline_status: if due_date.is_some() {
            if register
                .rule(
                    rule.as_ref().map(|r| r.code.as_str()).unwrap_or_default(),
                    policy_on,
                )?
                .disposition
                .is_hold()
            {
                "HOLD"
            } else {
                "VERIFIED"
            }
        } else {
            "UNKNOWN"
        }
        .into(),
        version: row.try_get("version")?,
        completed_on: row.try_get("completed_on")?,
        receipt_number: row.try_get("receipt_number")?,
        loss_code: row.try_get("loss_code")?,
        loss_options,
        detail: row.try_get("detail")?,
        opens_on: dates.as_ref().map(|d| d.opens_on.clone()),
        target_on: dates.as_ref().map(|d| d.target_on.clone()),
        due_on: due_date,
        dates,
        not_applicable_options: rule
            .as_ref()
            .map(console_compliance_domain::statutory::filing::resolution::reasons)
            .unwrap_or_default(),
        basis: rule,
        birth_date_known: assessment.facts.birth_date.is_some(),
        birth_date_for_assessment: assessment.facts.birth_date.clone(),
        can_record_sensitive_facts: false,
        applicability: assessment.applicability,
        applicability_facts: assessment.facts,
        state: assessment.state.into(),
        record_action: row.try_get("action")?,
        not_applicable_reason: not_applicable_reason.or(assessment.reason),
        total_remuneration_won: row.try_get("total_remuneration_won")?,
        is_request,
        acquired_on: row.try_get("acquired_on")?,
    }))
}
