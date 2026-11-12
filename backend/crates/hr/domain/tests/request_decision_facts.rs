// SPDX-License-Identifier: LicenseRef-Proprietary
use console_hr_domain::requests::{ChangeRequestKind as K, approval_class, decision_version};
use time::{Duration, OffsetDateTime};

#[test]
fn only_kinds_with_a_registered_inbox_policy_have_an_approval_class() {
    let expected = [
        Some("approval.policy.people_correction"),
        Some("approval.policy.identity_merge"),
        None,
        None,
        None,
        None,
        None,
        Some("approval.policy.registration_void"),
        Some("approval.policy.import_rollback"),
    ];
    assert_eq!(K::ALL.len(), expected.len());
    for (kind, key) in K::ALL.into_iter().zip(expected) {
        assert_eq!(approval_class(kind), key, "{kind:?}");
    }
}

#[test]
fn request_version_tracks_status_and_decision_time_only() {
    let first = OffsetDateTime::UNIX_EPOCH;
    let second = first + Duration::microseconds(1);
    let open = decision_version("OPEN", None);
    assert_eq!(open, decision_version("OPEN", None));
    let mut versions = std::collections::HashSet::from([open]);
    for status in ["APPLIED", "DECLINED", "WITHDRAWN"] {
        for at in [first, second] {
            assert!(versions.insert(decision_version(status, Some(at))));
        }
    }
}
