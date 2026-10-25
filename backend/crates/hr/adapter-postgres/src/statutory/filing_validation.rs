use super::refusal;
use crate::HrError;
use console_compliance_domain::statutory::filing::{FilingFacts, Reason};
use console_hr_domain::{
    filing::INSURERS,
    text::{normalize_optional_text, parse_yyyy_mm_dd},
};
use http::StatusCode;
use serde::{Deserialize, Serialize};
use time::Date;
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RecordFiling {
    pub expected_version: i64,
    pub action: String,
    pub completed_on: Option<String>,
    pub receipt_number: Option<String>,
    pub loss_code: Option<String>,
    pub detail: Option<String>,
    pub not_applicable_reason: Option<Reason>,
    pub applicability_facts: Option<FilingFacts>,
    pub total_remuneration_won: Option<i64>,
}

pub(super) fn invalid(message: &str) -> HrError {
    refusal(
        StatusCode::UNPROCESSABLE_ENTITY,
        "filing_record_invalid",
        message,
    )
}

pub(super) fn from_rule(error: console_kernel_core::KernelError) -> HrError {
    let code = error.code.unwrap_or("filing_record_invalid");
    let mut translated = HrError::from_kernel(error);
    translated.code = code;
    translated
}

pub(super) fn validate(body: &mut RecordFiling, insurer: &str, today: Date) -> Result<(), HrError> {
    body.receipt_number = normalize_optional_text(body.receipt_number.take());
    body.loss_code = normalize_optional_text(body.loss_code.take());
    body.detail = normalize_optional_text(body.detail.take());
    if !INSURERS.contains(&insurer)
        || body.expected_version < 0
        || !["COMPLETE", "UNDO", "NOT_APPLICABLE", "ASSESS"].contains(&body.action.as_str())
    {
        return Err(invalid(
            "Choose a filing action and insurer; no record was saved.",
        ));
    }
    for (text, max) in [
        (&body.receipt_number, 100),
        (&body.loss_code, 100),
        (&body.detail, 1000),
    ] {
        if text
            .as_ref()
            .is_some_and(|s| s.chars().count() > max || s.chars().any(char::is_control))
        {
            return Err(invalid(
                "A filing value is too long or contains control characters; shorten the value.",
            ));
        }
    }
    if body.total_remuneration_won.is_some_and(|n| n < 0) {
        return Err(invalid("Reported total remuneration cannot be negative."));
    }
    if let Some(facts) = &body.applicability_facts {
        if let Some(birth) = facts.birth_date.as_deref() {
            console_hr_domain::profile::facts::validate_birth_date(parse_yyyy_mm_dd(birth)?, today)
                .map_err(|_| invalid("Confirm a past birth date; no record was saved."))?;
        }
        facts
            .validate()
            .map_err(|_| invalid("Confirm valid applicability facts; no record was saved."))?;
    }
    match body.action.as_str() {
        "COMPLETE" => {
            let date = body
                .completed_on
                .as_deref()
                .and_then(|s| parse_yyyy_mm_dd(s).ok());
            if date.is_none_or(|d| d > today) || body.not_applicable_reason.is_some() {
                return Err(invalid(
                    "Choose the actual filing date, no later than today.",
                ));
            }
        }
        "NOT_APPLICABLE" => {
            if body.not_applicable_reason.is_none()
                || body.completed_on.is_some()
                || body.receipt_number.is_some()
                || body.loss_code.is_some()
                || body.total_remuneration_won.is_some()
                || body.detail.is_none()
            {
                return Err(invalid(
                    "Choose a cited not-applicable reason and enter its evidence; do not enter a filing date.",
                ));
            }
        }
        "ASSESS" => {
            if body.applicability_facts.is_none()
                || body.completed_on.is_some()
                || body.receipt_number.is_some()
                || body.loss_code.is_some()
                || body.detail.is_some()
                || body.not_applicable_reason.is_some()
                || body.total_remuneration_won.is_some()
            {
                return Err(invalid(
                    "Assessment requires only the version and typed applicability facts.",
                ));
            }
        }
        _ => {
            if body.completed_on.is_some()
                || body.receipt_number.is_some()
                || body.loss_code.is_some()
                || body.detail.is_some()
                || body.not_applicable_reason.is_some()
                || body.applicability_facts.is_some()
                || body.total_remuneration_won.is_some()
            {
                return Err(invalid(
                    "Undo keeps the original evidence; submit only the version and undo action.",
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    fn today() -> Date {
        time::macros::date!(2026 - 10 - 23)
    }
    #[test]
    fn statutory_rule_codes_survive_the_hr_translation() {
        for code in [
            "filing_record_invalid",
            "filing_applicability_unverified",
            "filing_not_applicable_invalid",
            "filing_remuneration_required",
        ] {
            let error =
                from_rule(console_kernel_core::KernelError::validation("refused").with_code(code));
            assert_eq!((error.status.as_u16(), error.code), (422, code));
        }
        assert_eq!(
            from_rule(console_kernel_core::KernelError::validation("refused")).code,
            "filing_record_invalid"
        );
    }
    fn body() -> RecordFiling {
        RecordFiling {
            expected_version: 0,
            action: "COMPLETE".into(),
            completed_on: Some(today().to_string()),
            receipt_number: None,
            loss_code: None,
            detail: None,
            not_applicable_reason: None,
            applicability_facts: None,
            total_remuneration_won: None,
        }
    }
    #[test]
    fn filing_record_invalid_rejects_every_input_guard() {
        for change in [0, 1, 2, 3, 4, 5, 6] {
            let mut b = body();
            let mut insurer = "NPS";
            match change {
                0 => insurer = "unknown",
                1 => b.expected_version = -1,
                2 => b.action = "DONE".into(),
                3 => b.completed_on = None,
                4 => b.completed_on = Some("9999-12-31".into()),
                5 => b.receipt_number = Some("a".repeat(101)),
                _ => b.action = "UNDO".into(),
            }
            let error = validate(&mut b, insurer, today()).unwrap_err();
            assert_eq!(
                (error.status.as_u16(), error.code),
                (422, "filing_record_invalid")
            );
        }
        assert!(validate(&mut body(), "NPS", today()).is_ok());
    }

    #[test]
    fn completion_uses_the_owning_workplaces_today() {
        let mut b = body();
        assert_eq!(
            validate(&mut b, "NPS", today().previous_day().unwrap())
                .unwrap_err()
                .code,
            "filing_record_invalid"
        );
        assert!(validate(&mut b, "NPS", today()).is_ok());
    }

    #[test]
    fn birth_date_uses_the_owning_workplaces_today() {
        let mut b = body();
        b.action = "ASSESS".into();
        b.completed_on = None;
        b.applicability_facts = Some(FilingFacts {
            birth_date: Some(today().to_string()),
            ..FilingFacts::default()
        });
        assert_eq!(
            validate(&mut b, "NPS", today().previous_day().unwrap())
                .unwrap_err()
                .code,
            "filing_record_invalid"
        );
        assert!(validate(&mut b, "NPS", today()).is_ok());
    }
}
