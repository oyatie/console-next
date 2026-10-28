// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[test]
fn a_future_decision_never_changes_the_request() {
    let mut request = request(&[Kind::Access]);
    assert_refusal(
        request.decide(
            Kind::Access,
            decision(Outcome::Granted, None),
            Date::MAX,
            date!(2026 - 11 - 07),
            &reason_codes(),
        ),
        "decision_date_invalid",
    );
    assert!(request.kinds()[&Kind::Access].decisions.is_empty());
}

#[test]
fn objection_cannot_include_an_undecided_or_unrequested_kind() {
    let mut original = request(&[Kind::Access, Kind::Deletion]);
    original
        .decide(
            Kind::Access,
            decision(Outcome::Granted, None),
            date!(2026 - 10 - 27),
            date!(2026 - 11 - 07),
            &reason_codes(),
        )
        .unwrap();
    for kinds in [
        vec![Kind::Deletion],
        vec![Kind::Suspension],
        vec![Kind::Access, Kind::Deletion],
    ] {
        assert_refusal(
            RightsRequest::receive(
                receipt(date!(2026 - 10 - 27)),
                kinds,
                &register(),
                date!(2026 - 10 - 27),
                Some((&original, 7)),
            ),
            "objection_before_result",
        );
    }
}

#[test]
fn both_kinds_of_representative_need_the_recorded_mandate() {
    let on = date!(2026 - 10 - 27);
    for agent in [AgentKind::LegalRepresentative, AgentKind::Authorized] {
        let mut input = receipt(on);
        input.agent = agent;
        assert_refusal(
            RightsRequest::receive(input.clone(), [Kind::Access], &register(), on, None),
            "mandate_required",
        );
        input.mandate_received = true;
        assert!(RightsRequest::receive(input, [Kind::Access], &register(), on, None).is_ok());
    }
}

#[test]
fn refusal_rules_follow_the_supplied_catalog_snapshot_without_a_rust_code_match() {
    let mut catalog = reason_codes();
    catalog
        .get_mut("privacy_refusal_access")
        .unwrap()
        .push("NEW_REGISTERED_CODE".into());
    catalog
        .get_mut("privacy_refusal_access")
        .unwrap()
        .retain(|c| c != "LAW_PROHIBITS");
    let mut request = request(&[Kind::Access]);
    let make = |code: &str| Decision {
        outcome: Outcome::Refused,
        reason: Some(code.into()),
        note: Some("근거 확인".into()),
    };
    assert_refusal(
        request.decide(
            Kind::Access,
            make("LAW_PROHIBITS"),
            date!(2026 - 10 - 27),
            date!(2026 - 10 - 27),
            &catalog,
        ),
        "reason_code_invalid",
    );
    assert!(request.kinds()[&Kind::Access].decisions.is_empty());
    request
        .decide(
            Kind::Access,
            make("NEW_REGISTERED_CODE"),
            date!(2026 - 10 - 27),
            date!(2026 - 10 - 27),
            &catalog,
        )
        .unwrap();
}
