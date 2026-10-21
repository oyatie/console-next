//! Imported company text is a candidate, never a legal entity creation request.
use super::plan::{Decisions, ImportRow, PlannedRow};
use super::review::{Resolution, ReviewItem, ReviewQueue};

#[derive(Debug, serde::Serialize)]
pub struct CompanyConfirmation {
    pub value: String,
    pub source_column: Option<String>,
    pub cell: Option<String>,
    pub registration_number: Option<String>,
    pub candidates: Vec<super::names::NameCandidate>,
    pub confirmed_employer: Option<String>,
}

#[must_use]
pub fn candidate_basis(
    row: &ImportRow,
    numbers: &[String],
    names: &[&str],
) -> Option<&'static str> {
    if let Some(brn) = &row.company_brn {
        let brn: String = brn.chars().filter(char::is_ascii_digit).collect();
        return numbers.contains(&brn).then_some("registration_number");
    }
    let key = |s: &str| super::cells::name_key(s).to_lowercase();
    names
        .iter()
        .any(|name| key(name) == key(&row.company))
        .then_some("alias")
}

#[must_use]
pub fn needs_confirmation(row: &ImportRow, outcome: &str, decisions: &Decisions) -> bool {
    (!row.company.is_empty() || row.company_brn.is_some())
        && matches!(outcome, "insert" | "update" | "unchanged")
        && !decisions
            .company_map
            .get(&company_key(row))
            .is_some_and(Option::is_some)
}

pub fn validate_confirmation(
    needed: bool,
    employer_confirmed: bool,
) -> Result<(), console_kernel_core::KernelError> {
    if needed && !employer_confirmed {
        return Err(console_kernel_core::KernelError::validation(
            "the company candidate is not certificate-confirmed",
        )
        .with_code("entity_certificate_unconfirmed")
        .with_field("company"));
    }
    Ok(())
}

#[must_use]
pub fn company_key(row: &ImportRow) -> String {
    let number = row
        .company_brn
        .as_ref()
        .map(|n| n.chars().filter(char::is_ascii_digit).collect::<String>());
    format!(
        "{}:{}:{}",
        row.company.len(),
        row.company,
        number.unwrap_or_default()
    )
}

pub fn append_company_review(
    queue: &mut ReviewQueue,
    rows: &[ImportRow],
    plans: &[PlannedRow],
    decisions: &Decisions,
    cell: &dyn Fn(&str, &str) -> Option<String>,
) {
    let relevant: std::collections::BTreeMap<_, _> = plans
        .iter()
        .map(|p| (p.source_key.as_str(), p.outcome))
        .collect();
    for row in rows {
        let Some(outcome) = relevant.get(row.source_key.as_str()) else {
            continue;
        };
        if !needs_confirmation(row, outcome, decisions) {
            continue;
        }
        queue.items.push(ReviewItem {
            source_column: None,
            id: format!("{}#company_unconfirmed", row.source_key),
            reason: "company_unconfirmed",
            blocking: false,
            sheet: row.sheet.clone(),
            row: Some(row.row),
            cell: cell(&row.source_key, "company"),
            field: Some("company"),
            value: Some(row.company.clone()),
            rows: 1,
            resolution: Some(Resolution {
                decision: "company_map",
                key: company_key(row),
                choices: vec![],
            }),
            candidates: vec![],
        });
    }
    queue.count = queue.items.len();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn registration_matching_has_priority_and_english_labels_are_candidates() {
        let mut row = ImportRow {
            company: "ganatech".into(),
            ..Default::default()
        };
        let numbers = vec!["0008100009".to_owned(), "0008600019".to_owned()];
        assert_eq!(
            candidate_basis(&row, &numbers, &["GANATECH"]),
            Some("alias")
        );
        row.company_brn = Some("000-81-00009".into());
        assert_eq!(
            candidate_basis(&row, &numbers, &["OTHER"]),
            Some("registration_number")
        );
        row.company_brn = Some("000-88-00008".into());
        assert_eq!(candidate_basis(&row, &numbers, &["GANATECH"]), None);
    }
    #[test]
    fn company_source_cannot_be_confirmed_without_a_confirmed_employer() {
        let error = validate_confirmation(true, false).unwrap_err();
        assert_eq!(error.code, Some("entity_certificate_unconfirmed"));
        assert!(validate_confirmation(true, true).is_ok());
        assert!(validate_confirmation(false, false).is_ok());
    }
    #[test]
    fn company_decisions_distinguish_labels_and_registration_numbers() {
        let row = |label: &str, brn: Option<&str>| ImportRow {
            company: label.into(),
            company_brn: brn.map(str::to_owned),
            ..Default::default()
        };
        assert_eq!(
            company_key(&row("GANATECH", Some("000-81-00009"))),
            company_key(&row("GANATECH", Some("0008100009")))
        );
        let keys: std::collections::BTreeSet<_> = [
            row("GANATECH", None),
            row("DANA", None),
            row("GANATECH", Some("0008100009")),
            row("GANATECH", Some("0008700016")),
        ]
        .iter()
        .map(company_key)
        .collect();
        assert_eq!(
            keys.len(),
            4,
            "one employer answer must never settle a different source value"
        );
    }
    #[test]
    fn representative_list_is_an_unresolved_alias_with_source_cell() {
        let row = ImportRow {
            source_key: "sheet:4".into(),
            sheet: "roster".into(),
            row: 4,
            name: "김민수".into(),
            hire_date: Some("2026-01-01".into()),
            company: "김예시,박예시".into(),
            ..ImportRow::default()
        };
        let empty = std::collections::BTreeMap::new();
        let numbering = crate::import::numbering::Numbering::default();
        let facts = crate::import::plan::PlanFacts {
            company_workplaces: &std::collections::BTreeMap::new(),
            people: &[],
            units: &empty,
            unit_workplaces: &std::collections::BTreeMap::new(),
            workplaces: &empty,
            today: time::macros::date!(2026 - 10 - 13),
            former_load_open: true,
            numbering: &numbering,
        };
        let plan = crate::import::plan_rows::plan_rows(
            std::slice::from_ref(&row),
            &facts,
            &Decisions::default(),
        )
        .remove(0);
        let mut queue = ReviewQueue::default();
        append_company_review(
            &mut queue,
            std::slice::from_ref(&row),
            std::slice::from_ref(&plan),
            &Decisions::default(),
            &|_, _| Some("C4".into()),
        );
        assert_eq!(queue.items[0].cell.as_deref(), Some("C4"));
        assert_eq!(queue.items[0].value.as_deref(), Some("김예시,박예시"));
        assert_eq!(
            queue.items[0].resolution.as_ref().unwrap().decision,
            "company_map"
        );
        assert!(!queue.items[0].blocking);
        for (plans, answer, expected) in [
            (vec![plan.clone()], Some(uuid::Uuid::new_v4()), 0),
            (vec![], None, 0),
            (vec![plan], None, 1),
        ] {
            let mut decisions = Decisions::default();
            decisions.company_map.insert(company_key(&row), answer);
            let mut queue = ReviewQueue::default();
            append_company_review(
                &mut queue,
                std::slice::from_ref(&row),
                &plans,
                &decisions,
                &|_, _| Some("C4".into()),
            );
            assert_eq!(queue.count, expected);
        }
    }
}
