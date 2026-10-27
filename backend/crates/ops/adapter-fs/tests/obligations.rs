// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use console_ops_adapter_fs::RecordSpool;
use console_ops_application::obligations::Register;
use serde_json::{Value, json};

mod support;
use support::Temp;
#[path = "support/obligation.rs"]
mod input;
use input::{context, opened};

#[test]
fn synthetic_register_lists_filters_and_returns_full_signed_history() {
    let tmp = Temp::new();
    let spool = RecordSpool::open(&tmp.0).unwrap();
    let register = Register::new(&spool);
    let context = context();
    let fixture: Value =
        serde_json::from_str(include_str!("../../domain/tests/fixtures/obligations.json")).unwrap();
    let fixtures = fixture["items"].as_array().unwrap();
    let mut ids = Vec::new();
    for fields in fixtures {
        let record = register
            .open(
                serde_json::from_value(json!({"event":"opened","fields":fields})).unwrap(),
                &context,
            )
            .unwrap();
        ids.push(record.entry.obligation_id);
    }
    let items = register.list(None, None).unwrap();
    assert_eq!(items.len(), fixtures.len());
    assert_eq!(
        ids.iter().collect::<std::collections::BTreeSet<_>>().len(),
        fixtures.len()
    );
    for (index, item) in items.iter().enumerate() {
        assert_eq!(
            serde_json::to_value(&item.obligation).unwrap()["state"],
            "open"
        );
        let expected = match index {
            7 => "D-65",
            8 => "D-26",
            27..=30 => "D-58",
            _ => "Unknown: no due date",
        };
        assert_eq!(item.obligation.deadline(context.at), expected);
    }
    let professional = serde_json::from_value(json!("professional-review")).unwrap();
    let expected = fixtures
        .iter()
        .filter(|row| row["kind"] == "professional-review")
        .count();
    assert_eq!(
        register.list(Some(professional), None).unwrap().len(),
        expected
    );
    let drill = items
        .iter()
        .find(|item| serde_json::to_value(&item.obligation).unwrap()["kind"] == "drill")
        .unwrap();
    assert_eq!(
        register
            .list(
                Some(serde_json::from_value(json!("drill")).unwrap()),
                Some(drill.obligation.state())
            )
            .unwrap()
            .len(),
        1
    );

    register
        .event(
            &ids[1],
            serde_json::from_value(json!({"event":"done","fields":{
                "evidence_ref":"ref-signed","signer":"Synthetic signer","signed_on":"2026-10-27"
            }}))
            .unwrap(),
            &context,
        )
        .unwrap();
    let detail = register.detail(&ids[1]).unwrap();
    assert_eq!(
        serde_json::to_value(&detail.item.obligation).unwrap()["state"],
        "done"
    );
    let history = serde_json::to_value(&detail.history).unwrap();
    assert_eq!(history[0]["event"], "opened");
    assert_eq!(history[1]["event"], "done");
    assert_eq!(detail.history[0].seq, 2);
    assert_eq!(detail.history[1].seq, fixtures.len() as u64 + 1);
    let stored = spool.read().unwrap();
    for record in detail.history {
        assert_eq!(record.entry.at, context.at);
        assert_eq!(record.entry.operator, context.operator);
        assert_eq!(record.support_ref, context.support_ref);
        assert_eq!(record.hash.len(), 64);
        assert_eq!(record.hash, stored[record.seq as usize - 1].hash);
    }
    assert_eq!(
        register
            .event(
                &ids[1],
                serde_json::from_value(json!({"event":"in_review","fields":{}})).unwrap(),
                &context
            )
            .unwrap_err()
            .code(),
        "OPS_OBLIGATION_FINAL"
    );
}

#[test]
fn incomplete_events_write_nothing() {
    for event in [
        json!({"event":"done","fields":{"evidence_ref":"ref","signed_on":"2026-10-27"}}),
        json!({"event":"done","fields":{"signer":"Synthetic","signed_on":"2026-10-27"}}),
        json!({"event":"done","fields":{"evidence_ref":"ref","signer":"Synthetic"}}),
        json!({"event":"waived","fields":{"reason":"Synthetic"}}),
        json!({"event":"waived","fields":{"signer":"Synthetic"}}),
        json!({"event":"redated","fields":{"due":"2026-11-22"}}),
    ] {
        let tmp = Temp::new();
        let spool = RecordSpool::open(&tmp.0).unwrap();
        let register = Register::new(&spool);
        let record = register
            .open(
                serde_json::from_value(opened("Synthetic")).unwrap(),
                &context(),
            )
            .unwrap();
        assert_eq!(
            register
                .event(
                    &record.entry.obligation_id,
                    serde_json::from_value(event).unwrap(),
                    &context()
                )
                .unwrap_err()
                .code(),
            "OPS_OBLIGATION_INCOMPLETE"
        );
        assert_eq!(spool.read().unwrap().len(), 1);
        assert!(!tmp.record(2).exists());
    }
}

#[test]
fn invalid_and_missing_items_are_distinct_refusals() {
    let tmp = Temp::new();
    let spool = RecordSpool::open(&tmp.0).unwrap();
    let register = Register::new(&spool);
    assert_eq!(
        register
            .open(serde_json::from_value(opened(" \t ")).unwrap(), &context())
            .unwrap_err()
            .code(),
        "OPS_OBLIGATION_INVALID"
    );
    assert_eq!(
        register.detail("missing").unwrap_err().code(),
        "OPS_OBLIGATION_NOT_FOUND"
    );
    assert_eq!(
        register
            .event(
                "missing",
                serde_json::from_value(json!({"event":"in_review","fields":{}})).unwrap(),
                &context()
            )
            .unwrap_err()
            .code(),
        "OPS_OBLIGATION_NOT_FOUND"
    );
    assert!(spool.read().unwrap().is_empty());
}

#[test]
fn review_and_redate_replay_without_changing_the_obligation_identity() {
    let tmp = Temp::new();
    let spool = RecordSpool::open(&tmp.0).unwrap();
    let register = Register::new(&spool);
    let record = register
        .open(
            serde_json::from_value(opened("Synthetic")).unwrap(),
            &context(),
        )
        .unwrap();
    let id = &record.entry.obligation_id;
    for event in [
        json!({"event":"in_review","fields":{"note":"Synthetic note"}}),
        json!({"event":"redated","fields":{"due":"2026-11-22","reason":"Synthetic reason"}}),
    ] {
        assert_eq!(
            register
                .event(id, serde_json::from_value(event).unwrap(), &context())
                .unwrap()
                .entry
                .obligation_id,
            *id
        );
    }
    let detail = register.detail(id).unwrap();
    assert_eq!(
        serde_json::to_value(&detail.item.obligation).unwrap()["state"],
        "in-review"
    );
    assert_eq!(detail.item.obligation.deadline(context().at), "D-26");
    assert_eq!(detail.history.len(), 3);
    assert_eq!(
        Register::new(&RecordSpool::open(&tmp.0).unwrap())
            .detail(id)
            .unwrap()
            .history[2]
            .hash,
        detail.history[2].hash
    );
}

#[test]
fn blank_request_provenance_cannot_commit_a_record() {
    for key in ["person", "method", "support_ref"] {
        let tmp = Temp::new();
        let spool = RecordSpool::open(&tmp.0).unwrap();
        let mut context = context();
        match key {
            "person" => context.operator.person = " ".into(),
            "method" => context.operator.method = " ".into(),
            _ => context.support_ref = " ".into(),
        }
        assert_eq!(
            Register::new(&spool)
                .open(
                    serde_json::from_value(opened("Synthetic")).unwrap(),
                    &context
                )
                .unwrap_err()
                .code(),
            "OPS_OBLIGATION_INVALID"
        );
        assert!(spool.read().unwrap().is_empty());
    }
}
