// SPDX-License-Identifier: LicenseRef-Proprietary
mod clocks;
mod grants;
mod objections;
mod regressions;
mod support;
use super::*;
use crate::statutory::{Citation, ReleaseDisposition, StatutoryRule};
use support::*;
use time::macros::date;

#[test]
fn every_refusal_code_is_limited_to_its_statutory_kinds() {
    for kind in [
        Kind::Access,
        Kind::Correction,
        Kind::Deletion,
        Kind::Suspension,
        Kind::Withdrawal,
        Kind::AutomatedDecision,
        Kind::Transmission,
    ] {
        for reason in [
            Ground::LawProhibits,
            Ground::HarmToOthers,
            Ground::RequiredByLaw,
            Ground::LawRequires,
            Ground::ContractPerformance,
            Ground::JustifiedReason,
        ] {
            let allowed = matches!(
                (kind, reason),
                (Kind::Access, Ground::LawProhibits | Ground::HarmToOthers)
                    | (Kind::Deletion, Ground::RequiredByLaw)
                    | (
                        Kind::Suspension | Kind::Withdrawal,
                        Ground::LawRequires | Ground::HarmToOthers | Ground::ContractPerformance
                    )
            );
            let mut request = request(&[kind]);
            let result = request.decide(
                kind,
                decision(Outcome::Refused, Some(reason)),
                date!(2026 - 10 - 27),
                date!(2026 - 11 - 07),
                &reason_codes(),
            );
            if allowed {
                result.unwrap();
            } else {
                assert_refusal(result, "reason_code_invalid");
            }
            assert_eq!(!request.kinds()[&kind].decisions.is_empty(), allowed);
        }
    }
}
#[test]
fn partial_result_uses_the_same_lawful_grounds_and_note_is_required() {
    let mut request = request(&[Kind::Access]);
    for outcome in [Outcome::Partial, Outcome::Refused] {
        assert_refusal(
            request.decide(
                Kind::Access,
                decision(outcome, None),
                date!(2026 - 10 - 27),
                date!(2026 - 11 - 07),
                &reason_codes(),
            ),
            "reason_code_invalid",
        );
        assert_refusal(
            request.decide(
                Kind::Access,
                Decision {
                    outcome,
                    reason: Some("LAW_PROHIBITS".into()),
                    note: Some("  ".into()),
                },
                date!(2026 - 10 - 27),
                date!(2026 - 11 - 07),
                &reason_codes(),
            ),
            "reason_note_required",
        );
        assert!(request.kinds()[&Kind::Access].decisions.is_empty());
    }
    request
        .decide(
            Kind::Access,
            decision(Outcome::Partial, Some(Ground::LawProhibits)),
            date!(2026 - 10 - 27),
            date!(2026 - 11 - 07),
            &reason_codes(),
        )
        .unwrap();
    assert_eq!(request.status(), Status::Decided);
}
#[test]
fn postponement_requires_access_a_known_unexpired_due_and_justified_reason() {
    for (kind, on, reason) in [
        (
            Kind::Suspension,
            date!(2026 - 10 - 27),
            Ground::JustifiedReason,
        ),
        (Kind::Access, date!(2026 - 11 - 07), Ground::JustifiedReason),
        (Kind::Access, date!(2026 - 10 - 27), Ground::LawProhibits),
    ] {
        let mut request = request(&[kind]);
        assert_refusal(
            request.decide(
                kind,
                decision(Outcome::Postponed, Some(reason)),
                on,
                date!(2026 - 11 - 07),
                &reason_codes(),
            ),
            "postpone_not_allowed",
        );
        assert!(request.kinds()[&kind].decisions.is_empty());
    }
    let on = date!(2026 - 09 - 10);
    let mut unknown =
        RightsRequest::receive(receipt(on), [Kind::Access], &register(), on, None).unwrap();
    assert_refusal(
        unknown.decide(
            Kind::Access,
            decision(Outcome::Postponed, Some(Ground::JustifiedReason)),
            on,
            date!(2026 - 11 - 07),
            &reason_codes(),
        ),
        "postpone_not_allowed",
    );
    let mut request = request(&[Kind::Access]);
    request
        .decide(
            Kind::Access,
            decision(Outcome::Postponed, Some(Ground::JustifiedReason)),
            date!(2026 - 11 - 06),
            date!(2026 - 11 - 07),
            &reason_codes(),
        )
        .unwrap();
    assert_eq!(request.status(), Status::Received);
    assert_refusal(
        request.decide(
            Kind::Access,
            decision(Outcome::Granted, None),
            date!(2026 - 11 - 05),
            date!(2026 - 11 - 07),
            &reason_codes(),
        ),
        "decision_date_invalid",
    );
    assert_refusal(
        request.decide(
            Kind::Access,
            decision(Outcome::Postponed, Some(Ground::JustifiedReason)),
            date!(2026 - 11 - 06),
            date!(2026 - 11 - 07),
            &reason_codes(),
        ),
        "postpone_not_allowed",
    );
    assert_eq!(request.kinds()[&Kind::Access].decisions.len(), 1);
    request
        .decide(
            Kind::Access,
            decision(Outcome::Granted, None),
            date!(2026 - 11 - 07),
            date!(2026 - 11 - 07),
            &reason_codes(),
        )
        .unwrap();
    assert_eq!(request.kinds()[&Kind::Access].decisions.len(), 2);
}
#[test]
fn decided_kinds_are_final_and_request_waits_for_every_kind() {
    let mut request = request(&[Kind::Access, Kind::Deletion]);
    request
        .decide(
            Kind::Access,
            decision(Outcome::Granted, None),
            date!(2026 - 10 - 27),
            date!(2026 - 11 - 07),
            &reason_codes(),
        )
        .unwrap();
    assert_eq!(request.status(), Status::Received);
    assert_refusal(
        request.decide(
            Kind::Access,
            decision(Outcome::Refused, Some(Ground::LawProhibits)),
            date!(2026 - 10 - 27),
            date!(2026 - 11 - 07),
            &reason_codes(),
        ),
        "request_already_decided",
    );
    assert_eq!(request.kinds()[&Kind::Access].decisions.len(), 1);
    request
        .decide(
            Kind::Deletion,
            decision(Outcome::Granted, None),
            date!(2026 - 10 - 27),
            date!(2026 - 11 - 07),
            &reason_codes(),
        )
        .unwrap();
    assert_eq!(request.status(), Status::Decided);
}
#[test]
fn empty_future_and_unproven_agent_receipts_are_refused() {
    let today = date!(2026 - 10 - 27);
    assert_refusal(
        RightsRequest::receive(receipt(today), [], &register(), today, None),
        "request_kind_required",
    );
    assert_refusal(
        RightsRequest::receive(
            receipt(date!(2026 - 10 - 28)),
            [Kind::Access],
            &register(),
            today,
            None,
        ),
        "received_on_invalid",
    );
    let mut agent = receipt(today);
    agent.agent = AgentKind::Authorized;
    assert_refusal(
        RightsRequest::receive(agent, [Kind::Access], &register(), today, None),
        "mandate_required",
    );
}
#[test]
fn duplicate_kinds_collapse_and_unrequested_or_backdated_decisions_do_not_write() {
    let mut request = request(&[Kind::Access, Kind::Access]);
    assert_eq!(request.kinds().len(), 1);
    assert_refusal(
        request.decide(
            Kind::Deletion,
            decision(Outcome::Granted, None),
            date!(2026 - 10 - 27),
            date!(2026 - 11 - 07),
            &reason_codes(),
        ),
        "request_kind_unavailable",
    );
    assert_refusal(
        request.decide(
            Kind::Access,
            decision(Outcome::Granted, None),
            date!(2026 - 10 - 26),
            date!(2026 - 11 - 07),
            &reason_codes(),
        ),
        "decision_date_invalid",
    );
    assert!(request.kinds()[&Kind::Access].decisions.is_empty());
}
