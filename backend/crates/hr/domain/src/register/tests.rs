use super::*;

fn row(from: &str, to: Option<&str>) -> CareerInput {
    CareerInput {
        employer_name: " 가나상사 ".into(),
        from: from.into(),
        to: to.map(Into::into),
        position: Some("대리".into()),
        duty: None,
        leave_reason: Some("  ".into()),
    }
}

#[test]
fn sex_parses_the_two_register_values_only() {
    assert_eq!(Sex::parse(" female ").unwrap(), Sex::Female);
    assert_eq!(Sex::parse("MALE").unwrap().as_str(), "MALE");
    assert!(Sex::parse("남").is_err());
}

#[test]
fn careers_are_trimmed_month_grained_and_ordered() {
    let rows = validate_careers(vec![row("2019-03", Some("2021-12"))]).unwrap();
    assert_eq!(rows[0].employer_name, "가나상사");
    assert_eq!(format_month(rows[0].from), "2019-03");
    assert_eq!(rows[0].leave_reason, None);
    let json = serde_json::to_value(&rows[0]).unwrap();
    assert_eq!(json["from"], "2019-03");
    assert_eq!(json["to"], "2021-12");
    assert!(validate_careers(vec![row("2021-12", Some("2019-03"))]).is_err());
    assert!(validate_careers(vec![row("2019-3", None)]).is_err());
    assert!(validate_careers(vec![row("2019-13", None)]).is_err());
    assert!(validate_careers(Vec::new()).unwrap().is_empty());
    let too_many = vec![row("2019-03", None); MAX_CAREER_ROWS + 1];
    assert!(validate_careers(too_many).is_err());
}

#[test]
fn the_note_is_bounded_and_blank_is_none() {
    assert_eq!(normalize_register_note("  ").unwrap(), None);
    assert!(normalize_register_note(&"가".repeat(501)).is_err());
}

#[test]
fn unknown_exit_reasons_have_no_label() {
    assert_eq!(
        exit_reason_label("DISCIPLINARY_DISMISSAL"),
        Some("징계해고")
    );
    assert_eq!(exit_reason_label("T_0123"), None);
}
