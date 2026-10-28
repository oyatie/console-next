// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
#[test]
fn objection_requires_a_decided_kind_and_uses_the_resolved_review_days() {
    let make = |original: &RightsRequest, days| {
        RightsRequest::receive(
            receipt(date!(2026 - 10 - 27)),
            [Kind::Access],
            &register(),
            date!(2026 - 10 - 27),
            Some((original, days)),
        )
    };
    let mut original = request(&[Kind::Access, Kind::Deletion]);
    assert_refusal(make(&original, 7), "objection_before_result");
    original
        .decide(
            Kind::Access,
            decision(Outcome::Postponed, Some(Ground::JustifiedReason)),
            date!(2026 - 10 - 27),
            date!(2026 - 10 - 27),
            &reason_codes(),
        )
        .unwrap();
    assert_refusal(make(&original, 7), "objection_before_result");
    original
        .decide(
            Kind::Access,
            decision(Outcome::Granted, None),
            date!(2026 - 10 - 27),
            date!(2026 - 10 - 27),
            &reason_codes(),
        )
        .unwrap();
    for days in [1, 7, 10, 30] {
        let objection = make(&original, days).unwrap();
        assert_eq!(objection.objection_of(), Some(original.receipt().id));
        let due = objection.kinds()[&Kind::Access].due.as_ref().unwrap();
        assert_eq!(
            due.on,
            Some(date!(2026 - 10 - 27) + time::Duration::days(i64::from(days)))
        );
        assert!(!due.without_delay);
        assert!(
            due.rule.is_none(),
            "operational review must not claim a statutory rule"
        );
        assert!(objection.kinds()[&Kind::Access].decisions.is_empty());
        assert_eq!(objection.status(), Status::Received);
    }
}
