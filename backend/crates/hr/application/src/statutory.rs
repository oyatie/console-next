//! Compose employment facts with the statutory register; adapters only load and serialize.
use console_compliance_domain::statutory::{
    StatutoryRegister,
    filing::{
        Applicability, FilingAnchors, FilingDates, FilingFacts, FilingRule, Reason, applies, dates,
        resolution,
    },
};
use console_hr_domain::{
    profile::enums::{EmploymentType, WorkerClassification},
    text::parse_yyyy_mm_dd,
};
use console_kernel_core::KernelError;
use time::Date;

pub struct FilingInput<'a> {
    pub kind: &'a str,
    pub insurer: &'a str,
    pub on: Date,
    pub acquired_on: Option<Date>,
    pub ended_on: Option<Date>,
    pub requested_acquisition_on: Option<Date>,
    pub today: Date,
    pub facts: FilingFacts,
    pub birth_date: Option<String>,
    pub employment_type: Option<String>,
    pub nationality: Option<String>,
    pub action: Option<String>,
    pub employment_filed: bool,
    pub request: bool,
}
pub struct FilingAssessment {
    pub on: Date,
    pub facts: FilingFacts,
    pub rule: Option<FilingRule>,
    pub dates: Option<FilingDates>,
    pub due_in_days: Option<i64>,
    pub opens_in_days: Option<i64>,
    pub deadline_status: &'static str,
    pub applicability: Applicability,
    pub reason: Option<Reason>,
    pub state: &'static str,
}
pub fn assess(
    mut input: FilingInput<'_>,
    register: &StatutoryRegister,
) -> Result<Option<FilingAssessment>, KernelError> {
    input.facts.birth_date = input.birth_date.or(input.facts.birth_date);
    if let Some(n) = input.nationality {
        input.facts.foreign = input.facts.foreign.or(Some(n != "KR"));
    }
    if let Some(t) = input.employment_type {
        let t = EmploymentType::parse(&t)?;
        input.facts.daily = input.facts.daily.or(Some(t == EmploymentType::Daily));
        if t.worker_classification() == WorkerClassification::Employee {
            input.facts.director_without_worker_status =
                input.facts.director_without_worker_status.or(Some(false));
        }
    }
    if input.kind == "AGE60" {
        if input.insurer != "NPS" {
            return Ok(None);
        }
        let Some(r) = register.filing_rule(input.insurer, input.kind, input.today)? else {
            return Ok(None);
        };
        let Some(years) = r.age_trigger_years else {
            return Ok(None);
        };
        let Some(birth) = input
            .facts
            .birth_date
            .as_deref()
            .map(parse_yyyy_mm_dd)
            .transpose()?
        else {
            return Ok(None);
        };
        let year = birth
            .year()
            .checked_add(i32::from(years))
            .ok_or_else(|| KernelError::validation("age trigger outside calendar"))?;
        let birthday = Date::from_calendar_date(
            year,
            birth.month(),
            birth.day().min(birth.month().length(year)),
        )
        .map_err(|_| KernelError::validation("age trigger outside calendar"))?;
        if birthday <= input.on
            || birthday > input.today
            || input.ended_on.is_some_and(|end| end <= birthday)
        {
            return Ok(None);
        }
        input.on = birthday;
    }
    let rule_kind = if input.kind == "ACQUIRE"
        && input.insurer == "EI"
        && input.requested_acquisition_on.is_some()
    {
        "ACQUIRE_REQUESTED"
    } else {
        input.kind
    };
    let rule_on = if matches!(input.kind, "LOSE" | "AGE60") {
        register
            .filing_rule(input.insurer, rule_kind, input.on)?
            .map(|r| r.loss_on(input.on))
            .transpose()?
            .unwrap_or(input.on)
    } else {
        input.on
    };
    let rule = register.filing_rule(input.insurer, rule_kind, rule_on)?;
    if rule.is_none()
        && (input.request
            || register
                .first_filing_date(input.insurer, rule_kind)?
                .is_some_and(|start| rule_on < start))
    {
        return Ok(None);
    }
    let anchors = FilingAnchors {
        effective_date: Some(input.on),
        acquire_date: if input.kind == "ACQUIRE" {
            Some(input.on)
        } else {
            input.acquired_on.or(Some(input.on))
        },
        exit_date: Some(input.on),
        loss_date: rule.map(|r| r.loss_on(input.on)).transpose()?,
        request_date: input.requested_acquisition_on.or(Some(input.on)),
        work_month: Some(input.on),
    };
    let dates = rule.map(|r| dates(r, &anchors, &[])).transpose()?;
    let applicable = rule
        .map(|r| applies(r, &anchors, &input.facts))
        .transpose()?
        .unwrap_or(Applicability::Unknown {
            missing: vec!["rule"],
        });
    let reason = if let Applicability::NotApplicable { reason } = &applicable {
        Some(*reason)
    } else {
        None
    };
    let covered =
        rule.is_some_and(|r| r.covered_by.as_deref() == Some("EI")) && input.employment_filed;
    let state = resolution::state(input.action.as_deref(), &applicable, covered);
    let due = dates
        .as_ref()
        .and_then(|d| d.due_on.as_deref())
        .map(parse_yyyy_mm_dd)
        .transpose()?;
    let policy_on = if matches!(input.kind, "LOSE" | "AGE60") {
        rule.map(|r| r.loss_on(input.on))
            .transpose()?
            .unwrap_or(input.on)
    } else {
        input.on
    };
    let deadline_status = if due.is_none() {
        "UNKNOWN"
    } else if register
        .rule(rule.map(|r| r.code.as_str()).unwrap_or_default(), policy_on)?
        .disposition
        .is_hold()
    {
        "HOLD"
    } else {
        "VERIFIED"
    };
    let opens_in_days = dates
        .as_ref()
        .map(|d| parse_yyyy_mm_dd(&d.opens_on).map(|on| (on - input.today).whole_days()))
        .transpose()?;
    Ok(Some(FilingAssessment {
        on: input.on,
        facts: input.facts,
        rule: rule.cloned(),
        dates,
        due_in_days: due.map(|on| (on - input.today).whole_days()),
        opens_in_days,
        deadline_status,
        applicability: applicable,
        reason,
        state,
    }))
}

pub fn validate_request(
    kind: &str,
    source_kind: &str,
    anchor: Date,
    opens_on: Date,
    today: Date,
) -> Result<(), KernelError> {
    let valid = match kind {
        "SEPARATION_CERTIFICATE" => source_kind == "LOSE" && anchor >= opens_on && anchor <= today,
        "ACQUIRE_REQUESTED" => source_kind == "ACQUIRE" && anchor >= opens_on && anchor <= today,
        "WORK_CONFIRMATION" | "MONTHLY_REMUNERATION" => {
            source_kind == "ACQUIRE"
                && anchor >= opens_on
                && anchor.day() == anchor.month().length(anchor.year())
                && (anchor.year(), anchor.month()) <= (today.year(), today.month())
        }
        _ => false,
    };
    if !valid {
        return Err(KernelError::validation(
            "Choose a filing request or work month that matches this employment event.",
        )
        .with_code("filing_request_invalid"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::date;
    #[test]
    fn requests_cannot_advance_a_future_acquisition_or_loss() {
        for (kind, source, on) in [
            ("SEPARATION_CERTIFICATE", "LOSE", date!(2026 - 11 - 01)),
            ("ACQUIRE_REQUESTED", "ACQUIRE", date!(2026 - 11 - 01)),
            ("WORK_CONFIRMATION", "ACQUIRE", date!(2026 - 11 - 01)),
        ] {
            assert_eq!(
                validate_request(
                    kind,
                    source,
                    date!(2026 - 10 - 12),
                    on,
                    date!(2026 - 10 - 12)
                )
                .err()
                .and_then(|e| e.code),
                Some("filing_request_invalid")
            );
        }
        assert!(
            validate_request(
                "SEPARATION_CERTIFICATE",
                "LOSE",
                date!(2026 - 10 - 12),
                date!(2026 - 10 - 11),
                date!(2026 - 10 - 12)
            )
            .is_ok()
        );
        assert!(
            validate_request(
                "WORK_CONFIRMATION",
                "ACQUIRE",
                date!(2026 - 09 - 30),
                date!(2026 - 09 - 01),
                date!(2026 - 10 - 12)
            )
            .is_ok()
        );
        assert!(
            validate_request(
                "WORK_CONFIRMATION",
                "ACQUIRE",
                date!(2026 - 09 - 29),
                date!(2026 - 09 - 01),
                date!(2026 - 10 - 12)
            )
            .is_err()
        );
    }
}
