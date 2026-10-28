// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[test]
fn granted_result_rejects_every_refusal_or_postponement_reason_without_writing() {
    let mut request = request(&[Kind::Access]);
    for reason in [
        Reason::LawProhibits,
        Reason::HarmToOthers,
        Reason::RequiredByLaw,
        Reason::LawRequires,
        Reason::ContractPerformance,
        Reason::JustifiedReason,
    ] {
        assert_refusal(
            request.decide(
                Kind::Access,
                decision(Outcome::Granted, Some(reason)),
                date!(2026 - 10 - 27),
            ),
            "reason_code_invalid",
        );
        assert!(request.kinds()[&Kind::Access].decisions.is_empty());
        assert_eq!(request.status(), Status::Received);
    }
    request
        .decide(
            Kind::Access,
            decision(Outcome::Granted, None),
            date!(2026 - 10 - 27),
        )
        .unwrap();
    assert_eq!(request.status(), Status::Decided);
}
