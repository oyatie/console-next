use super::types::{FilingTask, LossOption};
use crate::HrError;
use console_compliance_domain::statutory::filing::Reason;
use console_compliance_domain::statutory::{Insurer, StatutoryRegister};
use console_hr_domain::text::parse_yyyy_mm_dd;
use sqlx::{Row, postgres::PgRow};

pub(super) fn task(
    row: PgRow,
    register: &StatutoryRegister,
) -> Result<Option<FilingTask>, HrError> {
    let today: time::Date = row.try_get("today")?;
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
            today,
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
    let created_at = row.try_get("created_at")?;
    effective_date = on.to_string();
    let dates = assessment.dates;
    let rule = assessment.rule;
    let due_date = dates.as_ref().and_then(|d| d.due_on.clone());
    let due_in_days = due_date
        .as_deref()
        .map(parse_yyyy_mm_dd)
        .transpose()?
        .map(|d| (d - today).whole_days());
    if due_date
        .as_deref()
        .map(parse_yyyy_mm_dd)
        .transpose()?
        .is_some_and(|due| due < row.get::<time::Date, _>("go_live_on"))
    {
        return Ok(None);
    }
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
        filing_obligation_id: row.try_get("filing_obligation_id")?,
        lifecycle_case_id: row.try_get("lifecycle_case_id")?,
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
        opens_in_days: dates
            .as_ref()
            .map(|d| parse_yyyy_mm_dd(&d.opens_on).map(|on| (on - today).whole_days()))
            .transpose()?,
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
        state: if row.try_get::<Option<bool>, _>("recording_held")? == Some(true) {
            "LEGAL_REVIEW"
        } else {
            assessment.state
        }
        .into(),
        record_action: row.try_get("action")?,
        not_applicable_reason: not_applicable_reason.or(assessment.reason),
        total_remuneration_won: row.try_get("total_remuneration_won")?,
        is_request,
        acquired_on: row.try_get("acquired_on")?,
    }))
}

/// Filing validation uses the same source placement and zone as its read model.
pub(super) async fn source_today(
    conn: &mut sqlx::PgConnection,
    org: uuid::Uuid,
    event: uuid::Uuid,
    kind: &str,
) -> Result<time::Date, HrError> {
    Ok(sqlx::query_scalar(
        "WITH sources AS (SELECT l.employee_id,l.effective_date::date AS anchor_on,l.effective_date::date AS placement_on,l.event_type \
         FROM employee_lifecycle_events l WHERE l.org_id=$1 AND l.id=$2 UNION ALL \
         SELECT r.employee_id,r.anchor_on,l.effective_date::date,l.event_type FROM insurance_filing_requests r \
         JOIN employee_lifecycle_events l ON l.org_id=r.org_id AND l.id=r.source_event_id WHERE r.org_id=$1 AND r.id=$2), \
         source_zone AS (SELECT lifecycle_time_zone($1,s.employee_id,s.anchor_on,a.workplace_id) AS zone FROM sources s \
         LEFT JOIN LATERAL (SELECT a.workplace_id FROM employment_assignments a WHERE a.org_id=$1 AND a.employee_id=s.employee_id \
           AND a.superseded_at IS NULL AND a.valid_from<=s.placement_on \
           AND (s.event_type<>'GROUP_TRANSFER' OR $3 NOT IN ('LOSE','SEPARATION_CERTIFICATE') OR a.valid_from<s.placement_on) \
           ORDER BY a.valid_from DESC LIMIT 1) a ON true LIMIT 1) \
         SELECT (now() AT TIME ZONE COALESCE((SELECT zone FROM source_zone),lifecycle_time_zone($1,NULL,current_date,NULL)))::date",
    )
    .bind(org)
    .bind(event)
    .bind(kind)
    .fetch_one(conn)
    .await?)
}
