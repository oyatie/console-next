// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
#[test]
fn objection_requires_a_result_and_records_original_id() {
    let make = |original: &RightsRequest| {
        RightsRequest::receive(
            receipt(date!(2026 - 10 - 27)),
            [Kind::Access],
            &register(),
            date!(2026 - 10 - 27),
            Some(original),
        )
    };
    for (outcome, reason) in [
        (Outcome::Refused, Reason::LawProhibits),
        (Outcome::Postponed, Reason::JustifiedReason),
    ] {
        let mut original = request(&[Kind::Access]);
        assert_refusal(make(&original), "objection_before_result");
        original
            .decide(
                Kind::Access,
                decision(outcome, Some(reason)),
                date!(2026 - 10 - 27),
            )
            .unwrap();
        let objection = make(&original).unwrap();
        assert_eq!(objection.objection_of(), Some(original.receipt().id));
        // No statutory review deadline: the operational setting belongs to slice 1b.
        assert!(objection.kinds()[&Kind::Access].due.is_none());
        assert!(objection.kinds()[&Kind::Access].decisions.is_empty());
        assert_eq!(objection.status(), Status::Received);
    }
}
