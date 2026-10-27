// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use console_ops_domain::{
    Health,
    obligation::{Event, Obligation, launch_readiness, worklist},
};
use serde_json::{Value, json};
use time::macros::datetime;

fn apply(item: Option<&Obligation>, event: &str, fields: Value) -> Obligation {
    let event: Event = serde_json::from_value(json!({"event":event,"fields":fields})).unwrap();
    Obligation::evolve(item, &event).unwrap()
}

fn open(kind: &str, title: &str, due: Option<&str>) -> Obligation {
    apply(
        None,
        "opened",
        json!({"kind":kind,"title":title,"reviewer_role":"owner","due":due}),
    )
}

#[test]
fn readiness_never_turns_green_for_empty_or_open_gates() {
    let unknown = launch_readiness(Ok(&[]));
    assert_eq!(unknown.text, "Unknown: no launch gates recorded");
    assert_eq!(unknown.worst, Health::Unknown);
    assert_eq!(
        launch_readiness(Ok(&[open("drill", "Drill", None)])),
        unknown
    );
    let gate = open("launch-gate", "Launch check", None);
    let review = apply(Some(&gate), "in_review", json!({}));
    let blocked = launch_readiness(Ok(&[gate.clone(), review.clone()]));
    assert_eq!(blocked.text, "Blocked: 2 launch gates open");
    assert_eq!(blocked.worst, Health::Degraded);
    let done = apply(
        Some(&gate),
        "done",
        json!({"evidence_ref":"receipt","signer":"Synthetic owner","signed_on":"2026-10-27"}),
    );
    let waived = apply(
        Some(&review),
        "waived",
        json!({"reason":"Superseded","signer":"Synthetic owner"}),
    );
    assert_eq!(
        launch_readiness(Ok(&[done.clone(), review])).text,
        "Blocked: 1 launch gate open"
    );
    assert_eq!(
        launch_readiness(Ok(std::slice::from_ref(&done))).text,
        "Ready: all 1 launch gate done or waived (signed)"
    );
    let ready = launch_readiness(Ok(&[done, waived]));
    assert_eq!(
        ready.text,
        "Ready: all 2 launch gates done or waived (signed)"
    );
    assert_eq!(ready.worst, Health::Healthy);
}

#[test]
fn synthetic_rows_include_six_launch_gates_and_five_owner_decisions() {
    let fixtures: Value = serde_json::from_str(include_str!("fixtures/obligations.json")).unwrap();
    let items: Vec<_> = fixtures["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|fields| apply(None, "opened", fields.clone()))
        .collect();
    assert_eq!(
        launch_readiness(Ok(&items)).text,
        "Blocked: 6 launch gates open"
    );
    let work = worklist(&items, datetime!(2026-11-20 00:00 UTC), 7);
    assert_eq!(work.len(), 26);
    assert_eq!(
        serde_json::to_value(work[0]).unwrap()["title"],
        "Synthetic credential rotation 9"
    );
    assert_eq!(work[0].deadline(datetime!(2026-11-23 00:00 UTC)), "D+1");
    assert_eq!(
        work.iter()
            .filter(|item| serde_json::to_value(item).unwrap()["kind"] == "owner-decision")
            .count(),
        5
    );
}

#[test]
fn broken_or_unreadable_records_cannot_report_launch_ready() {
    for reason in ["record chain broken at 3", "records unreadable"] {
        let verdict = launch_readiness(Err(reason));
        assert_eq!(verdict.text, format!("Unknown: {reason}"));
        assert_eq!(verdict.worst, Health::Unknown);
    }
}

#[test]
fn worklist_ranks_overdue_owner_decisions_first_and_undated_last() {
    let mut items = vec![
        open("drill", "Undated", None),
        open("credential-rotation", "Due soon", Some("2026-11-22")),
        open("drill", "Older overdue", Some("2026-11-01")),
        open("owner-decision", "Owner overdue", Some("2026-11-19")),
        open("launch-gate", "Future gate", Some("2027-01-01")),
        open("drill", "Future drill", Some("2027-01-01")),
    ];
    let titles = |items: &[Obligation]| {
        worklist(items, datetime!(2026-11-20 00:00 UTC), 7)
            .into_iter()
            .map(|item| {
                serde_json::to_value(item).unwrap()["title"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(
        titles(&items),
        [
            "Owner overdue",
            "Older overdue",
            "Due soon",
            "Future gate",
            "Undated"
        ]
    );
    items[3] = apply(
        Some(&items[3]),
        "waived",
        json!({"reason":"Resolved","signer":"Synthetic owner"}),
    );
    assert_eq!(
        titles(&items),
        ["Older overdue", "Due soon", "Future gate", "Undated"]
    );
    assert!(worklist(&items[1..2], datetime!(2026-11-14 00:00 UTC), 7).is_empty());
    assert_eq!(
        worklist(&items[1..2], datetime!(2026-11-15 00:00 UTC), 7).len(),
        1
    );
}

#[test]
fn worklist_tiebreak_due_orders_each_bucket_by_earliest_date() {
    let items = [
        open("launch-gate", "Later future gate", Some("2027-02-01")),
        open("launch-gate", "Earlier future gate", Some("2027-01-01")),
        open("drill", "Later due", Some("2026-11-27")),
        open("drill", "Earlier due", Some("2026-11-20")),
        open("drill", "Later overdue", Some("2026-11-19")),
        open("drill", "Earlier overdue", Some("2026-11-01")),
        open("owner-decision", "Later owner", Some("2026-11-19")),
        open("owner-decision", "Earlier owner", Some("2026-11-01")),
    ];
    let work = worklist(&items, datetime!(2026-11-20 00:00 UTC), 7);
    assert_eq!(work, [7, 6, 5, 4, 3, 2, 1, 0].map(|i| &items[i]));
}
