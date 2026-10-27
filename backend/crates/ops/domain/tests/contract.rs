// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use std::num::NonZeroU64;

use console_ops_domain::{EvidenceState, Health, Observed, WorkKind, roll_up, verdict};
use proptest::prelude::*;
use time::{OffsetDateTime, macros::datetime};

fn observation(age_s: u64) -> Observed<u64> {
    Observed::current(
        42,
        Some("count".into()),
        "fixture".into(),
        datetime!(2026-01-01 00:00 UTC),
        datetime!(2026-01-01 00:00 UTC) + time::Duration::seconds(age_s as i64),
        NonZeroU64::new(60).unwrap(),
    )
}

#[test]
fn stale_values_are_unknown_and_not_returned_as_current() {
    let current = serde_json::to_value(observation(120)).unwrap();
    assert_eq!(current["state"], "Verified");
    assert_eq!(current["value"], 42);
    let stale = serde_json::to_value(observation(180)).unwrap();
    assert_eq!(stale["state"], "Unknown");
    assert_eq!(stale["reason"], "stale 3m");
    assert_eq!(stale["age_s"], 180);
    assert!(stale["value"].is_null());
    assert_eq!(stale["observed_at"], "2026-01-01T00:00:00Z");
}

#[test]
fn fractional_age_and_large_intervals_do_not_round_into_freshness() {
    let at = datetime!(2026-01-01 00:00 UTC);
    let past_boundary = Observed::current(
        1,
        None,
        "fixture".into(),
        at,
        at + time::Duration::milliseconds(120_001),
        NonZeroU64::new(60).unwrap(),
    );
    assert_eq!(
        serde_json::to_value(past_boundary).unwrap()["state"],
        "Unknown"
    );
    let long_interval = Observed::current(
        1,
        None,
        "fixture".into(),
        at,
        at + time::Duration::days(1),
        NonZeroU64::new(u64::MAX).unwrap(),
    );
    assert_eq!(
        serde_json::to_value(long_interval).unwrap()["state"],
        "Verified"
    );
}

#[test]
fn timestamps_are_utc_and_future_observations_are_unknown() {
    let at = OffsetDateTime::parse(
        "2026-01-01T09:00:00+09:00",
        &time::format_description::well_known::Rfc3339,
    )
    .unwrap();
    let value = |now| {
        Observed::current(
            1,
            None,
            "fixture".into(),
            at,
            now,
            NonZeroU64::new(60).unwrap(),
        )
    };
    assert_eq!(
        serde_json::to_value(value(at)).unwrap()["observed_at"],
        "2026-01-01T00:00:00Z"
    );
    let future = serde_json::to_value(value(at - time::Duration::SECOND)).unwrap();
    assert_eq!(future["state"], "Unknown");
    assert!(future["value"].is_null());
}

#[test]
fn an_empty_roll_up_or_unverified_evidence_cannot_be_quiet() {
    assert_eq!(roll_up([]), Health::Unknown);
    assert_eq!(
        roll_up([Health::Degraded, Health::Unknown]),
        Health::Unknown
    );
    assert!(
        verdict(Health::Healthy, &[], &[EvidenceState::Verified])
            .text
            .starts_with("All quiet")
    );
    for evidence in [
        vec![],
        vec![EvidenceState::Unknown],
        vec![EvidenceState::Monitoring],
        vec![EvidenceState::Stale],
    ] {
        let result = verdict(Health::Healthy, &[], &evidence);
        assert!(!result.text.contains("All quiet"));
        assert!(!result.text.contains("0 pages"));
        assert_eq!(result.worst, Health::Unknown);
    }
    assert!(
        !verdict(Health::Missing, &[], &[EvidenceState::Verified])
            .text
            .contains("All quiet")
    );
    assert!(
        !verdict(
            Health::Healthy,
            &[WorkKind::Page],
            &[EvidenceState::Verified]
        )
        .text
        .contains("All quiet")
    );
}

#[test]
fn needs_a_human_order_is_page_overdue_due_ticket() {
    let mut work = [
        WorkKind::Ticket,
        WorkKind::Due,
        WorkKind::Page,
        WorkKind::Overdue,
    ];
    work.sort();
    assert_eq!(
        work,
        [
            WorkKind::Page,
            WorkKind::Overdue,
            WorkKind::Due,
            WorkKind::Ticket
        ]
    );
}

#[test]
fn unknown_source_carries_a_reason_and_no_current_value_or_invented_timestamp() {
    let missing = Observed::<u64>::unknown("fixture".into(), "source down".into());
    assert_eq!(missing.state(), EvidenceState::Unknown);
    assert!(missing.value().is_none());
    assert_eq!(missing.reason(), Some("source down"));
    let body = serde_json::to_value(missing).unwrap();
    assert!(body["observed_at"].is_null());
    assert!(body["value"].is_null());
}

fn health(n: u8) -> Health {
    [
        Health::Healthy,
        Health::Progressing,
        Health::Suspended,
        Health::Degraded,
        Health::Missing,
        Health::Unknown,
    ][usize::from(n)]
}

proptest! {
    #[test]
    fn roll_up_is_worst_child_independent_of_order(children in prop::collection::vec(0u8..6, 1..100)) {
        let states: Vec<_> = children.into_iter().map(health).collect();
        let worst = roll_up(states.iter().copied());
        prop_assert!(states.contains(&worst));
        prop_assert!(states.iter().all(|state| *state <= worst));
        prop_assert_eq!(worst, roll_up(states.into_iter().rev()));
    }

    #[test]
    fn unknown_dominates_degraded(child in 0u8..6) {
        prop_assert_eq!(roll_up([Health::Degraded, health(child), Health::Unknown]), Health::Unknown);
    }
}
