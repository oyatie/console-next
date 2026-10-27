// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use console_ops_domain::obligation::{Event, Kind, Obligation, Refusal, State};
use serde_json::{Value, json};
use time::macros::datetime;

fn event(value: Value) -> Event {
    serde_json::from_value(value).unwrap()
}

fn opened() -> Event {
    event(json!({"event":"opened", "fields":{
        "kind":"professional-review", "reviewer_role":"lawyer", "title":"Review"
    }}))
}

fn done() -> Event {
    event(json!({"event":"done", "fields":{
        "evidence_ref":"synthetic receipt", "signer":"Synthetic reviewer", "signed_on":"2026-10-27"
    }}))
}

#[test]
fn all_synthetic_acceptance_rows_open_with_expected_dates_and_filters() {
    let fixtures: Value = serde_json::from_str(include_str!("fixtures/obligations.json")).unwrap();
    let items: Vec<_> = fixtures["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|fields| {
            Obligation::evolve(None, &event(json!({"event":"opened", "fields":fields}))).unwrap()
        })
        .collect();
    assert_eq!(items.len(), 31);
    assert!(items.iter().all(|item| item.state() == State::Open));
    assert_eq!(
        items
            .iter()
            .filter(|item| item.kind() == Kind::ProfessionalReview)
            .count(),
        12
    );
    assert_eq!(
        items
            .iter()
            .filter(|item| item.kind() == Kind::Drill && item.state() == State::Open)
            .count(),
        1
    );
    let now = datetime!(2026-10-27 00:00 UTC);
    assert_eq!(items[8].deadline(now), "D-26");
    assert_eq!(items[7].deadline(now), "D-65");
    let watches: Vec<_> = items
        .iter()
        .filter(|item| serde_json::to_value(item).unwrap()["kind"] == "regulatory-watch")
        .collect();
    assert_eq!(watches.len(), 3);
    assert!(watches.iter().all(|item| item.deadline(now) == "D-58"));
    assert_eq!(
        items
            .iter()
            .filter(|item| item.deadline(now) == "Unknown: no due date")
            .count(),
        25
    );
    assert_eq!(
        serde_json::to_value(&items[8]).unwrap()["due"],
        "2026-11-22"
    );
}

#[test]
fn close_keeps_signoff_and_refuses_every_further_event() {
    let open = Obligation::evolve(None, &opened()).unwrap();
    let review = event(json!({"event":"in_review", "fields":{"note":"Assigned"}}));
    let in_review = Obligation::evolve(Some(&open), &review).unwrap();
    assert_eq!(in_review.state(), State::InReview);
    for initial in [&open, &in_review] {
        let closed = Obligation::evolve(Some(initial), &done()).unwrap();
        assert_eq!(closed.state(), State::Done);
        let value = serde_json::to_value(&closed).unwrap();
        assert_eq!(value["signer"], "Synthetic reviewer");
        assert_eq!(value["signed_on"], "2026-10-27");
        assert_eq!(value["evidence_ref"], "synthetic receipt");
        for next in [
            opened(),
            review.clone(),
            done(),
            event(json!({"event":"redated", "fields":{
                "due":"2026-11-01", "reason":"Rescheduled"
            }})),
        ] {
            assert_eq!(
                Obligation::evolve(Some(&closed), &next),
                Err(Refusal::Final)
            );
        }
    }
}

#[test]
fn waived_is_final_from_both_live_states() {
    let open = Obligation::evolve(None, &opened()).unwrap();
    let review = Obligation::evolve(
        Some(&open),
        &event(json!({"event":"in_review", "fields":{}})),
    )
    .unwrap();
    for initial in [&open, &review] {
        let waived = Obligation::evolve(
            Some(initial),
            &event(json!({"event":"waived", "fields":{
                "reason":"No longer applies", "signer":"Synthetic owner"
            }})),
        )
        .unwrap();
        assert_eq!(waived.state(), State::Waived);
        assert_eq!(
            serde_json::to_value(&waived).unwrap()["signer"],
            "Synthetic owner"
        );
        assert_eq!(
            Obligation::evolve(Some(&waived), &done()),
            Err(Refusal::Final)
        );
    }
}

#[test]
fn incomplete_signoff_and_redates_preserve_the_original_item() {
    let open = Obligation::evolve(None, &opened()).unwrap();
    for (name, complete, required) in [
        (
            "done",
            json!({"evidence_ref":"receipt", "signer":"Reviewer", "signed_on":"2026-10-27"}),
            vec!["evidence_ref", "signer", "signed_on"],
        ),
        (
            "waived",
            json!({"reason":"Not applicable", "signer":"Owner"}),
            vec!["reason", "signer"],
        ),
        (
            "redated",
            json!({"due":"2026-11-01", "reason":"Rescheduled"}),
            vec!["due", "reason"],
        ),
    ] {
        for key in required {
            let mut fields = complete.clone();
            fields.as_object_mut().unwrap().remove(key);
            assert_eq!(
                Obligation::evolve(Some(&open), &event(json!({"event":name, "fields":fields}))),
                Err(Refusal::Incomplete),
                "{name}: {key}"
            );
            if key != "due" && key != "signed_on" {
                fields[key] = json!(" \t\n");
                assert_eq!(
                    Obligation::evolve(Some(&open), &event(json!({"event":name, "fields":fields}))),
                    Err(Refusal::Incomplete)
                );
            }
        }
    }
    assert_eq!(open.state(), State::Open);
    assert_eq!(Refusal::Incomplete.code(), "OPS_OBLIGATION_INCOMPLETE");
}

#[test]
fn invalid_titles_and_transitions_are_refused() {
    let empty = event(json!({"event":"opened", "fields":{
        "kind":"drill", "reviewer_role":"owner", "title":" \n "
    }}));
    assert_eq!(Obligation::evolve(None, &empty), Err(Refusal::Invalid));
    let open = Obligation::evolve(None, &opened()).unwrap();
    assert_eq!(
        Obligation::evolve(Some(&open), &opened()),
        Err(Refusal::Invalid)
    );
    let review = event(json!({"event":"in_review", "fields":{}}));
    let reviewed = Obligation::evolve(Some(&open), &review).unwrap();
    assert_eq!(
        Obligation::evolve(Some(&reviewed), &review),
        Err(Refusal::Invalid)
    );
    assert_eq!(Refusal::Invalid.code(), "OPS_OBLIGATION_INVALID");
}

#[test]
fn unknown_kinds_roles_events_and_malformed_dates_fail_at_the_boundary() {
    for fields in [
        json!({"kind":"unknown", "reviewer_role":"owner", "title":"Review"}),
        json!({"kind":"drill", "reviewer_role":"unknown", "title":"Review"}),
        json!({"kind":"drill", "reviewer_role":"owner", "title":"Review", "due":"2026-02-30"}),
        json!({"kind":"drill", "reviewer_role":"owner", "title":"Review", "due":"27/10/2026"}),
    ] {
        assert!(
            serde_json::from_value::<Event>(json!({"event":"opened", "fields":fields})).is_err()
        );
    }
    for value in [
        json!({"event":"deleted", "fields":{}}),
        json!({"event":"done", "fields":{"signed_on":"yesterday"}}),
        json!({"event":"redated", "fields":{"due":"2026-13-01"}}),
        json!({"event":"in_review", "fields":{"signer":"Injected"}}),
    ] {
        assert!(serde_json::from_value::<Event>(value).is_err());
    }
}

#[test]
fn non_opening_events_require_an_existing_item() {
    assert_eq!(Obligation::evolve(None, &done()), Err(Refusal::NotFound));
    assert_eq!(Refusal::NotFound.code(), "OPS_OBLIGATION_NOT_FOUND");
    assert_eq!(Refusal::Final.code(), "OPS_OBLIGATION_FINAL");
}

#[test]
fn redates_apply_only_while_live_and_keep_review_state() {
    let mut item = Obligation::evolve(None, &opened()).unwrap();
    for state in [State::Open, State::InReview] {
        if state == State::InReview {
            item = Obligation::evolve(
                Some(&item),
                &event(json!({"event":"in_review", "fields":{}})),
            )
            .unwrap();
        }
        item = Obligation::evolve(
            Some(&item),
            &event(json!({"event":"redated", "fields":{
                "due":"2026-10-27", "reason":"Agreed latest deadline"
            }})),
        )
        .unwrap();
        assert_eq!(item.state(), state);
        assert_eq!(item.deadline(datetime!(2026-10-27 00:00 UTC)), "D-day");
        assert_eq!(item.deadline(datetime!(2026-10-28 00:00 UTC)), "D+1");
        assert_eq!(item.deadline(datetime!(2026-10-28 01:00 +09:00)), "D-day");
    }
}
