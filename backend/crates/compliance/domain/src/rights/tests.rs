// SPDX-License-Identifier: LicenseRef-Proprietary
mod clocks;
mod grants;
mod objections;
use super::*;
use crate::statutory::{Citation, ReleaseDisposition, StatutoryRule};
use time::macros::date;

fn assert_refusal<T: std::fmt::Debug>(result: Result<T, KernelError>, code: &str) {
    assert_eq!(result.unwrap_err(), KernelError::validation(code));
}
fn register() -> StatutoryRegister {
    StatutoryRegister::new(
        [
            codes::PIPA_ACCESS_RESPONSE_DAYS,
            codes::PIPA_CORRECTION_RESPONSE_DAYS,
            codes::PIPA_SUSPENSION_RESPONSE_DAYS,
        ]
        .into_iter()
        .map(|code| StatutoryRule {
            code: code.into(),
            effective_from: date!(2026 - 09 - 11),
            effective_to_exclusive: None,
            unit: StatutoryUnit::Days,
            value_num: 10,
            value_den: 1,
            citation: Citation {
                instrument_ko: "개인정보 보호법 시행령".into(),
                article_ko: "제41조·제43조·제44조".into(),
                source_url: "https://www.law.go.kr/법령/개인정보보호법시행령".into(),
            },
            disposition: ReleaseDisposition::Hold,
        })
        .collect(),
        vec![],
    )
    .unwrap()
}
fn receipt(on: Date) -> Receipt {
    Receipt {
        id: Uuid::new_v4(),
        controller: Controller::Tenant,
        channel: Channel::InApp,
        agent: AgentKind::Subject,
        mandate_received: false,
        identity_method: IdentityMethod::SignedIn,
        identity_at: time::OffsetDateTime::UNIX_EPOCH,
        received_on: on,
    }
}
fn request(kinds: &[Kind]) -> RightsRequest {
    RightsRequest::receive(
        receipt(date!(2026 - 10 - 27)),
        kinds.iter().copied(),
        &register(),
        date!(2026 - 10 - 27),
        None,
    )
    .unwrap()
}
fn decision(outcome: Outcome, reason: Option<Reason>) -> Decision {
    Decision {
        outcome,
        reason,
        note: Some("법정 근거와 조치 내용을 확인했습니다.".into()),
    }
}
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
            Reason::LawProhibits,
            Reason::HarmToOthers,
            Reason::RequiredByLaw,
            Reason::LawRequires,
            Reason::ContractPerformance,
            Reason::JustifiedReason,
        ] {
            let allowed = matches!(
                (kind, reason),
                (Kind::Access, Reason::LawProhibits | Reason::HarmToOthers)
                    | (Kind::Deletion, Reason::RequiredByLaw)
                    | (
                        Kind::Suspension | Kind::Withdrawal,
                        Reason::LawRequires | Reason::HarmToOthers | Reason::ContractPerformance
                    )
            );
            let mut request = request(&[kind]);
            let result = request.decide(
                kind,
                decision(Outcome::Refused, Some(reason)),
                date!(2026 - 10 - 27),
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
            request.decide(Kind::Access, decision(outcome, None), date!(2026 - 10 - 27)),
            "reason_code_invalid",
        );
        assert_refusal(
            request.decide(
                Kind::Access,
                Decision {
                    outcome,
                    reason: Some(Reason::LawProhibits),
                    note: Some("  ".into()),
                },
                date!(2026 - 10 - 27),
            ),
            "reason_note_required",
        );
        assert!(request.kinds()[&Kind::Access].decisions.is_empty());
    }
    request
        .decide(
            Kind::Access,
            decision(Outcome::Partial, Some(Reason::LawProhibits)),
            date!(2026 - 10 - 27),
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
            Reason::JustifiedReason,
        ),
        (Kind::Access, date!(2026 - 11 - 07), Reason::JustifiedReason),
        (Kind::Access, date!(2026 - 10 - 27), Reason::LawProhibits),
    ] {
        let mut request = request(&[kind]);
        assert_refusal(
            request.decide(kind, decision(Outcome::Postponed, Some(reason)), on),
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
            decision(Outcome::Postponed, Some(Reason::JustifiedReason)),
            on,
        ),
        "postpone_not_allowed",
    );
    let mut request = request(&[Kind::Access]);
    request
        .decide(
            Kind::Access,
            decision(Outcome::Postponed, Some(Reason::JustifiedReason)),
            date!(2026 - 11 - 06),
        )
        .unwrap();
    assert_eq!(request.status(), Status::Received);
    assert_refusal(
        request.decide(
            Kind::Access,
            decision(Outcome::Granted, None),
            date!(2026 - 11 - 05),
        ),
        "decision_date_invalid",
    );
    assert_refusal(
        request.decide(
            Kind::Access,
            decision(Outcome::Postponed, Some(Reason::JustifiedReason)),
            date!(2026 - 11 - 06),
        ),
        "postpone_not_allowed",
    );
    assert_eq!(request.kinds()[&Kind::Access].decisions.len(), 1);
    request
        .decide(
            Kind::Access,
            decision(Outcome::Granted, None),
            date!(2026 - 11 - 07),
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
        )
        .unwrap();
    assert_eq!(request.status(), Status::Received);
    assert_refusal(
        request.decide(
            Kind::Access,
            decision(Outcome::Refused, Some(Reason::LawProhibits)),
            date!(2026 - 10 - 27),
        ),
        "request_already_decided",
    );
    assert_eq!(request.kinds()[&Kind::Access].decisions.len(), 1);
    request
        .decide(
            Kind::Deletion,
            decision(Outcome::Granted, None),
            date!(2026 - 10 - 27),
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
        ),
        "request_kind_unavailable",
    );
    assert_refusal(
        request.decide(
            Kind::Access,
            decision(Outcome::Granted, None),
            date!(2026 - 10 - 26),
        ),
        "decision_date_invalid",
    );
    assert!(request.kinds()[&Kind::Access].decisions.is_empty());
}
