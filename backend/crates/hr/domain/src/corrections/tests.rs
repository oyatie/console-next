use super::*;

#[test]
fn name_and_phone_are_low_risk_and_the_rest_high_risk() {
    for field in ["name", "phone"] {
        assert_eq!(correction_route(field).unwrap(), CorrectionRoute::Low);
    }
    for field in ["hire_date", "employment_type", "base_pay"] {
        assert_eq!(correction_route(field).unwrap(), CorrectionRoute::High);
    }
}

#[test]
fn position_fails_closed_and_unknown_fields_are_invalid() {
    assert!(matches!(
        correction_route("position_id").unwrap(),
        CorrectionRoute::Unavailable(_)
    ));
    assert!(correction_route("salary").is_err());
}

#[test]
fn a_second_holder_takes_the_request_and_a_sole_holder_follows_the_mode() {
    assert_eq!(
        high_risk_path(1, true, true),
        Some(HighRiskPath::SecondPerson)
    );
    assert_eq!(
        high_risk_path(0, false, true),
        Some(HighRiskPath::SoleHolderReview)
    );
    assert_eq!(high_risk_path(0, true, true), None);
}

#[test]
fn approval_policy_none_needs_no_second_person() {
    // decisions #26: the actor applies it after the step-up, whoever else holds it.
    for (other, refuse) in [(0, false), (0, true), (3, false), (3, true)] {
        assert_eq!(
            high_risk_path(other, refuse, false),
            Some(HighRiskPath::SoleHolderReview)
        );
    }
}

#[test]
fn verdicts_round_trip() {
    for verdict in [IdentityVerdict::Same, IdentityVerdict::Different] {
        assert_eq!(IdentityVerdict::parse(verdict.as_str()).unwrap(), verdict);
    }
    assert!(IdentityVerdict::parse("MAYBE").is_err());
}

#[test]
fn every_scalar_field_has_a_route_and_placements_point_at_the_assignment() {
    for field in ["job", "work_email", "id_type"] {
        assert_eq!(correction_route(field).unwrap(), CorrectionRoute::Low);
    }
    for field in [
        "exit_date",
        "birth_date",
        "employee_number",
        "pay_unit",
        "probation_end_date",
    ] {
        assert_eq!(correction_route(field).unwrap(), CorrectionRoute::High);
    }
    for field in ["company", "worksite_name", "worksite_address", "org_unit"] {
        assert!(matches!(
            correction_route(field).unwrap(),
            CorrectionRoute::Unavailable(why) if why.contains("assignment")
        ));
    }
}

#[test]
fn a_first_recording_needs_no_second_person() {
    assert_eq!(
        route_for_current(CorrectionRoute::High, false),
        CorrectionRoute::Low
    );
    assert_eq!(
        route_for_current(CorrectionRoute::High, true),
        CorrectionRoute::High
    );
    let refused = CorrectionRoute::Unavailable("x");
    assert_eq!(route_for_current(refused, false), refused);
}

#[test]
fn register_items_route_like_their_risk() {
    for field in ["sex", "address", "careers", "register_note"] {
        assert_eq!(correction_route(field).unwrap(), CorrectionRoute::Low);
    }
    let reason = correction_route("exit_reason").unwrap();
    assert_eq!(reason, CorrectionRoute::High);
    assert_eq!(route_for_current(reason, false), CorrectionRoute::Low);
}

#[test]
fn personal_extras_are_low_risk_except_the_group_service_start() {
    for field in crate::personal::PERSONAL_FIELDS {
        let expected = if field == "group_service_start_date" {
            CorrectionRoute::High
        } else {
            CorrectionRoute::Low
        };
        assert_eq!(correction_route(field).unwrap(), expected, "{field}");
    }
}

#[test]
fn catalog_fields_take_the_correction_path_without_a_personnel_action() {
    for field in [
        "grade_id",
        "job_title_id",
        "position_kind_id",
        "job_id",
        "job_family_id",
    ] {
        assert_eq!(correction_route(field).unwrap(), CorrectionRoute::Low);
    }
}
