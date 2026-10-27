// SPDX-License-Identifier: LicenseRef-Proprietary
use console_ops_domain::{EvidenceState, Health, verdict};

#[test]
fn verdict_uses_one_unknown_prefix_with_or_without_a_reason() {
    for reason in [
        None,
        Some("stale 3m"),
        Some("source down"),
        Some("not instrumented"),
    ] {
        let text = verdict(Health::Healthy, &[], &[(EvidenceState::Unknown, reason)]).text;
        assert_eq!(text.matches("Unknown:").count(), 1, "{text}");
        assert!(text.contains("1 source not verified"));
    }
}
