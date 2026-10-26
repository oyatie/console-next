// SPDX-License-Identifier: LicenseRef-Proprietary
//! Missing applicability facts keep work visible until their basis is verified.
use crate::HrError;
use console_compliance_domain::statutory::{
    StatutoryRegister, StatutoryUnit, codes,
    filing::{Applicability, FilingFacts},
};
use console_hr_application::statutory::{FilingInput, assess};
use serde_json::json;
use sqlx::{Postgres, Row, Transaction};
use std::collections::BTreeMap;
use time::Date;
use uuid::Uuid;
type Facts = BTreeMap<String, Option<bool>>;
fn evaluate(predicates: &[String], facts: &Facts) -> Option<bool> {
    let mut known = true;
    for predicate in predicates {
        let (negative, name) = predicate
            .strip_prefix('!')
            .map_or((false, predicate.as_str()), |name| (true, name));
        match facts
            .get(name)
            .copied()
            .flatten()
            .map(|value| value != negative)
        {
            Some(false) => return Some(false),
            None => known = false,
            Some(true) => (),
        }
    }
    known.then_some(true)
}
fn carried(group: bool, item: &str, severance: Option<&str>, annual: Option<&str>) -> Option<bool> {
    if !group {
        return Some(false);
    }
    match if item == "X4" { annual } else { severance } {
        Some("CARRIED") => Some(true),
        Some("SETTLED") => Some(false),
        _ => None,
    }
}
pub(crate) async fn apply(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    case: Uuid,
    register: &StatutoryRegister,
) -> Result<(), HrError> {
    let rows = sqlx::query(
        "SELECT i.id,i.item_key,i.status,i.status_code,i.mode,i.kind AS item_kind,l.event_type,i.due_rule_ref,t.applicability,c.variant,c.kind, \
           c.effective_date,e.hire_on,e.birth_date::text AS birth_date,p.employment_type,f.nationality, \
           s.severance_pay_won,g.continuity,COALESCE(g.annual_leave_continuity,g.continuity) AS annual_continuity, \
           (now() AT TIME ZONE lifecycle_time_zone(c.org_id,c.employee_id,c.effective_date,c.workplace_id))::date AS today, \
           EXISTS(SELECT 1 FROM employee_lifecycle_events l WHERE l.org_id=c.org_id \
             AND l.id=COALESCE(x.exit_lifecycle_event_id,c.trigger_id) AND l.state='SCHEDULED') AS scheduled, \
           CASE WHEN COALESCE(c.legal_entity_id,anchor.legal_entity_id) IS NULL THEN NULL ELSE EXISTS( \
             SELECT 1 FROM employment_assignments a WHERE a.org_id=c.org_id AND a.employee_id=c.employee_id \
               AND a.superseded_at IS NULL AND a.legal_entity_id<>COALESCE(c.legal_entity_id,anchor.legal_entity_id) \
               AND (a.valid_from>=c.effective_date OR a.valid_to IS NULL OR a.valid_to>c.effective_date)) END AS elsewhere \
         FROM lifecycle_case_items i JOIN lifecycle_cases c ON c.org_id=i.org_id AND c.id=i.case_id \
         JOIN case_template_items t ON t.template_key=c.template_key AND t.version=c.template_version AND t.item_key=i.item_key \
         JOIN person_employees_current e ON e.org_id=c.org_id AND e.id=c.employee_id \
         LEFT JOIN employee_employment_profiles p ON p.org_id=e.org_id AND p.employee_id=e.id \
         LEFT JOIN employee_personal_facts f ON f.org_id=e.org_id AND f.employee_id=e.id \
         LEFT JOIN employee_exit_cases x ON x.org_id=c.org_id AND x.id=c.exit_case_id \
         LEFT JOIN employee_lifecycle_events l ON l.org_id=c.org_id AND l.id=COALESCE(x.exit_lifecycle_event_id,c.trigger_id) \
         LEFT JOIN employee_group_transfers g ON g.org_id=c.org_id AND g.lifecycle_event_id=COALESCE(x.exit_lifecycle_event_id,c.trigger_id) \
         LEFT JOIN employee_exit_settlement_packages s ON s.org_id=c.org_id AND s.exit_case_id=c.exit_case_id \
         LEFT JOIN LATERAL (SELECT a.legal_entity_id FROM employment_assignments a \
           WHERE a.org_id=c.org_id AND a.employee_id=c.employee_id AND a.superseded_at IS NULL \
             AND a.valid_from<=c.effective_date ORDER BY a.valid_from DESC LIMIT 1) anchor ON true \
         WHERE i.org_id=$1 AND c.id=$2 AND c.state='OPEN' AND i.status IN ('OPEN','PENDING_TRIGGER','BLOCKED') \
         FOR UPDATE OF i",
    ).bind(org).bind(case).fetch_all(tx.as_mut()).await?;
    let mut updates = Vec::with_capacity(rows.len());
    for row in rows {
        let on: Date = row.try_get("effective_date")?;
        let hire: Option<Date> = row.try_get("hire_on")?;
        let minimum_service = register
            .rule(codes::EMPLOYMENT_CERTIFICATE_MIN_SERVICE_DAYS, on)
            .ok()
            .and_then(|rule| rule.whole(StatutoryUnit::Days).ok());
        let severance: Option<String> = row.try_get("continuity")?;
        let annual: Option<String> = row.try_get("annual_continuity")?;
        let group = severance.is_some()
            || row.try_get::<Option<String>, _>("variant")?.as_deref() == Some("GROUP_TRANSFER");
        let carried = carried(
            group,
            &row.try_get::<String, _>("item_key")?,
            severance.as_deref(),
            annual.as_deref(),
        );
        let mut facts = Facts::from([
            ("CONTINUITY_CARRIED".to_owned(), carried),
            ("CONTINUITY_SETTLED".to_owned(), carried.map(|value| !value)),
            (
                "SUBJECT_DECEASED".to_owned(),
                row.try_get::<Option<String>, _>("variant")?
                    .map(|variant| variant == "DEATH"),
            ),
            (
                "EMPLOYED_ELSEWHERE_IN_TENANT".to_owned(),
                row.try_get("elsewhere")?,
            ),
            (
                "SEVERANCE_ELIGIBLE".to_owned(),
                row.try_get::<Option<i64>, _>("severance_pay_won")?
                    .map(|won| won > 0),
            ),
            (
                "SERVICE_GE_30_DAYS".to_owned(),
                hire.zip(minimum_service)
                    .map(|(hire, days)| (on - hire).whole_days() >= days),
            ),
        ]);
        let mut predicates: Vec<String> = row.try_get("applicability")?;
        if let Some(rule) = row
            .try_get::<Option<String>, _>("due_rule_ref")?
            .as_deref()
            .map(|code| register.filing_rule_by_code(code, on))
            .transpose()?
            .flatten()
        {
            if row.try_get::<String, _>("item_kind")? == "FIL" {
                let applies = row
                    .try_get::<Option<String>, _>("event_type")?
                    .is_none_or(|event| rule.trigger_event_kinds.contains(&event));
                facts.insert("REGISTER_TRIGGER_APPLIES".into(), Some(applies));
                predicates.push("REGISTER_TRIGGER_APPLIES".into());
            }
            let assessment = assess(
                FilingInput {
                    kind: rule.filing_kind.clone(),
                    insurer: rule.insurer.clone(),
                    on,
                    acquired_on: hire,
                    ended_on: (row.try_get::<String, _>("kind")? == "EXIT").then_some(on),
                    requested_acquisition_on: None,
                    today: row.try_get("today")?,
                    facts: FilingFacts::default(),
                    birth_date: row.try_get("birth_date")?,
                    employment_type: row.try_get("employment_type")?,
                    nationality: row.try_get("nationality")?,
                    action: None,
                    employment_filed: false,
                    request: false,
                },
                register,
            )?;
            facts.insert(
                format!("INSURER_APPLIES_{}", rule.insurer),
                assessment.and_then(|assessment| match assessment.applicability {
                    Applicability::Applies => Some(true),
                    Applicability::NotApplicable { .. } => Some(false),
                    Applicability::Unknown { .. } => None,
                }),
            );
        }
        let verdict = evaluate(&predicates, &facts);
        let old_status: String = row.try_get("status")?;
        let old_code: Option<String> = row.try_get("status_code")?;
        let scheduled: bool = row.try_get("scheduled")?;
        let pending = scheduled || row.try_get::<String, _>("mode")? == "REQUESTED";
        let (status, code) = match verdict {
            Some(false) => ("NOT_APPLICABLE", Some("APPLICABILITY_EXCLUDED")),
            None if scheduled => ("PENDING_TRIGGER", None),
            None => ("BLOCKED", Some("APPLICABILITY_UNVERIFIED")),
            Some(true) if old_code.as_deref() == Some("APPLICABILITY_UNVERIFIED") => {
                (if pending { "PENDING_TRIGGER" } else { "OPEN" }, None)
            }
            Some(true) => (old_status.as_str(), old_code.as_deref()),
        };
        let basis = json!({"applicability":{"status":match verdict {Some(true)=>"APPLIES",Some(false)=>"EXCLUDED",None=>"UNVERIFIED"},"predicates":predicates}});
        updates.push(
            json!({"id":row.try_get::<Uuid,_>("id")?,"status":status,"code":code,"basis":basis}),
        );
    }
    sqlx::query("UPDATE lifecycle_case_items i SET status=r.status,status_code=r.code, \
      done_at=CASE WHEN r.status='NOT_APPLICABLE' THEN now() ELSE NULL END,due_basis=i.due_basis||r.basis,version=i.version+1 \
      FROM jsonb_to_recordset($2) r(id uuid,status text,code text,basis jsonb) \
      WHERE i.org_id=$1 AND i.id=r.id AND (i.status,i.status_code,i.due_basis->'applicability') \
        IS DISTINCT FROM (r.status,r.code,r.basis->'applicability')")
        .bind(org).bind(serde_json::Value::Array(updates)).execute(tx.as_mut()).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn predicates(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| (*name).to_owned()).collect()
    }

    #[test]
    fn predicates_require_every_known_fact_and_preserve_unknown_negation() {
        let facts = Facts::from([
            ("SUBJECT_DECEASED".into(), Some(false)),
            ("SEVERANCE_ELIGIBLE".into(), Some(true)),
        ]);
        assert_eq!(evaluate(&predicates(&[]), &facts), Some(true));
        assert_eq!(
            evaluate(
                &predicates(&["!SUBJECT_DECEASED", "SEVERANCE_ELIGIBLE"]),
                &facts
            ),
            Some(true)
        );
        assert_eq!(
            evaluate(&predicates(&["SUBJECT_DECEASED"]), &facts),
            Some(false)
        );
        assert_eq!(evaluate(&predicates(&["MINOR"]), &facts), None);
        assert_eq!(evaluate(&predicates(&["!MINOR"]), &facts), None);
        assert_eq!(
            evaluate(&predicates(&["MINOR", "SUBJECT_DECEASED"]), &facts),
            Some(false)
        );
    }

    #[test]
    fn every_template_predicate_is_three_valued() {
        for name in [
            "HEADCOUNT_5_PLUS",
            "HEADCOUNT_10_PLUS",
            "HEADCOUNT_100_PLUS_NHIS",
            "SERVICE_GE_3_MONTHS",
            "SERVICE_GE_30_DAYS",
            "SEVERANCE_ELIGIBLE",
            "MINOR",
            "DAILY_UNDER_30_DAYS",
            "SUBJECT_DECEASED",
            "EMPLOYED_ELSEWHERE_IN_TENANT",
            "TERMS_CHANGE_BY_RULES",
            "INSURER_APPLIES_EI",
            "INSURER_APPLIES_NPS",
            "INSURER_APPLIES_NHIS",
            "INSURER_APPLIES_IACI",
            "OWN_INSURANCE_UNIT",
            "HAS_DC_PLAN",
            "PAY_CHANGES",
            "TERMS_CHANGE",
            "REGISTERED_BRANCH",
            "NEW_INCORPORATION",
            "FIRST_HIRE_RECORDED",
            "CONTINUITY_SETTLED",
            "CONTINUITY_CARRIED",
        ] {
            assert_eq!(
                evaluate(&predicates(&[name]), &Facts::new()),
                None,
                "{name}"
            );
            for known in [false, true] {
                let facts = Facts::from([(name.to_owned(), Some(known))]);
                assert_eq!(
                    evaluate(&predicates(&[name]), &facts),
                    Some(known),
                    "{name}"
                );
                assert_eq!(
                    evaluate(&[format!("!{name}")], &facts),
                    Some(!known),
                    "{name}"
                );
            }
        }
    }

    #[test]
    fn continuity_uses_the_item_dimension_without_exempting_final_wages() {
        assert_eq!(
            carried(true, "X4", Some("SETTLED"), Some("CARRIED")),
            Some(true)
        );
        assert_eq!(
            carried(true, "X4", Some("CARRIED"), Some("SETTLED")),
            Some(false)
        );
        for item in ["X5", "X7", "X15", "GT3"] {
            assert_eq!(
                carried(true, item, Some("CARRIED"), Some("SETTLED")),
                Some(true)
            );
            assert_eq!(
                carried(true, item, Some("SETTLED"), Some("CARRIED")),
                Some(false)
            );
        }
        assert_eq!(carried(true, "X5", None, None), None);
        assert_eq!(carried(false, "X5", None, None), Some(false));
        let facts = Facts::from([("CONTINUITY_CARRIED".into(), Some(true))]);
        assert_eq!(
            evaluate(&predicates(&["!CONTINUITY_CARRIED"]), &facts),
            Some(false)
        );
        assert_eq!(evaluate(&predicates(&[]), &facts), Some(true));
    }
}
