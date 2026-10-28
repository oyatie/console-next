// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use console_ops_adapter_fs::RecordSpool;
use console_ops_application::obligations::{Context, Register};
use serde_json::json;

mod support;
use support::Temp;
#[path = "support/obligation.rs"]
mod input;
use input::{context, opened};

#[test]
fn event_cannot_open_a_caller_chosen_id_and_open_requires_opened() {
    let tmp = Temp::new();
    let spool = RecordSpool::open(&tmp.0).unwrap();
    let register = Register::new(&spool);
    assert_eq!(
        register
            .event(
                "9",
                serde_json::from_value(opened("Synthetic collision")).unwrap(),
                &context(),
            )
            .unwrap_err()
            .code(),
        "OPS_OBLIGATION_INVALID"
    );
    assert_eq!(
        register
            .open(
                serde_json::from_value(json!({"event":"in_review","fields":{}})).unwrap(),
                &context(),
            )
            .unwrap_err()
            .code(),
        "OPS_OBLIGATION_INVALID"
    );
    assert!(spool.read().unwrap().is_empty());
    assert!(!tmp.record(1).exists());
    for seq in 1..=9 {
        let record = register
            .open(
                serde_json::from_value(opened("Synthetic item")).unwrap(),
                &context(),
            )
            .unwrap();
        assert_eq!(record.entry.obligation_id, seq.to_string());
    }
    assert_eq!(register.list(None, None).unwrap().len(), 9);
}

#[test]
fn offset_context_is_persisted_as_utc_before_reporting_success() {
    let tmp = Temp::new();
    let spool = RecordSpool::open(&tmp.0).unwrap();
    let utc_context = context();
    let offset_context: Context = serde_json::from_value(json!({
        "at":"2026-10-27T00:30:00+09:00",
        "operator": utc_context.operator,
        "support_ref": utc_context.support_ref,
    }))
    .unwrap();
    let record = Register::new(&spool)
        .open(
            serde_json::from_value(opened("Synthetic offset")).unwrap(),
            &offset_context,
        )
        .unwrap();
    let document: serde_json::Value =
        serde_json::from_slice(&std::fs::read(tmp.record(1)).unwrap()).unwrap();
    assert_eq!(document["at"], "2026-10-26T15:30:00Z");
    assert_eq!(record.entry.at, offset_context.at);
    let reopened = RecordSpool::open(&tmp.0).unwrap();
    assert_eq!(
        Register::new(&reopened).detail("1").unwrap().history.len(),
        1
    );
}

#[test]
fn state_filter_excludes_closed_items_independently_of_kind() {
    let tmp = Temp::new();
    let spool = RecordSpool::open(&tmp.0).unwrap();
    let register = Register::new(&spool);
    for _ in 0..2 {
        register
            .open(
                serde_json::from_value(opened("Synthetic drill")).unwrap(),
                &context(),
            )
            .unwrap();
    }
    register
        .event(
            "1",
            serde_json::from_value(json!({"event":"done","fields":{
                "evidence_ref":"ref-signed","signer":"Synthetic signer","signed_on":"2026-10-27"
            }}))
            .unwrap(),
            &context(),
        )
        .unwrap();
    let done = register.detail("1").unwrap().item.obligation;
    let open = register.detail("2").unwrap().item.obligation;
    for kind in [None, Some(open.kind())] {
        let closed_items = register.list(kind, Some(done.state())).unwrap();
        assert_eq!(closed_items.len(), 1);
        assert_eq!(closed_items[0].id, "1");
        let open_items = register.list(kind, Some(open.state())).unwrap();
        assert_eq!(open_items.len(), 1);
        assert_eq!(open_items[0].id, "2");
    }
}
