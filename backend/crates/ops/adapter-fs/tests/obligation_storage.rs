// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use std::{fs, sync::Arc};

use console_ops_adapter_fs::RecordSpool;
use console_ops_application::obligations::{Error, Register};
use serde_json::json;

mod support;
use support::Temp;
#[path = "support/obligation.rs"]
mod input;
use input::{context, opened};

#[test]
fn invalid_persisted_transition_is_a_broken_chain_even_with_valid_hashes() {
    let tmp = Temp::new();
    let spool = RecordSpool::open(&tmp.0).unwrap();
    spool
        .append("synthetic-ref", |_| {
            let mut record = opened("Synthetic").as_object().unwrap().clone();
            record.insert("at".into(), json!("2026-10-27T00:00:00Z"));
            record.insert(
                "operator".into(),
                json!({"person":"00000000-0000-4000-8000-000000000001","method":"access"}),
            );
            record.insert("obligation_id".into(), json!("synthetic-id"));
            Ok::<_, ()>(record)
        })
        .unwrap();
    spool
        .append("synthetic-ref", |records| {
            let mut record = records[0].document.as_object().unwrap().clone();
            record.insert("event".into(), json!("done"));
            record.insert("fields".into(), json!({}));
            Ok::<_, ()>(record)
        })
        .unwrap();
    let register = Register::new(&spool);
    let error = register.list(None, None).unwrap_err();
    assert_eq!(error, Error::ChainBroken(2));
    assert_eq!(error.reason(), "record chain broken at 2");
    assert_eq!(register.detail("synthetic-id").unwrap_err(), error);
    assert_eq!(
        register
            .open(
                serde_json::from_value(opened("Refused")).unwrap(),
                &context()
            )
            .unwrap_err(),
        error
    );
    assert!(!tmp.record(3).exists());
}

#[test]
fn corrupt_or_missing_files_refuse_list_detail_and_append() {
    for delete in [false, true] {
        let tmp = Temp::new();
        let spool = RecordSpool::open(&tmp.0).unwrap();
        let register = Register::new(&spool);
        for _ in 0..5 {
            register
                .open(
                    serde_json::from_value(opened("Synthetic")).unwrap(),
                    &context(),
                )
                .unwrap();
        }
        let seq = if delete { 4 } else { 3 };
        if delete {
            fs::remove_file(tmp.record(seq)).unwrap();
        } else {
            fs::write(tmp.record(seq), b"!").unwrap();
        }
        assert_eq!(
            register.list(None, None).unwrap_err(),
            Error::ChainBroken(seq)
        );
        assert_eq!(register.detail("1").unwrap_err(), Error::ChainBroken(seq));
        assert_eq!(
            register
                .open(
                    serde_json::from_value(opened("Refused")).unwrap(),
                    &context()
                )
                .unwrap_err()
                .code(),
            "OPS_RECORD_CHAIN_BROKEN"
        );
        assert!(!tmp.record(6).exists());
    }
}

#[test]
fn concurrent_final_events_commit_once() {
    let tmp = Temp::new();
    let spool = Arc::new(RecordSpool::open(&tmp.0).unwrap());
    let record = Register::new(spool.as_ref())
        .open(
            serde_json::from_value(opened("Synthetic")).unwrap(),
            &context(),
        )
        .unwrap();
    let workers: Vec<_> = (0..8).map(|_| {
        let spool = Arc::clone(&spool);
        let id = record.entry.obligation_id.clone();
        std::thread::spawn(move || Register::new(spool.as_ref()).event(&id, serde_json::from_value(json!({"event":"waived","fields":{"signer":"Synthetic","reason":"Superseded"}})).unwrap(), &context()))
    }).collect();
    let results: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert!(
        results
            .iter()
            .filter_map(|result| result.as_ref().err())
            .all(|error| error.code() == "OPS_OBLIGATION_FINAL")
    );
    assert_eq!(spool.read().unwrap().len(), 2);
}

#[test]
fn empty_spool_is_known_but_an_unreadable_spool_is_unknown() {
    let tmp = Temp::new();
    let spool = RecordSpool::open(&tmp.0).unwrap();
    let register = Register::new(&spool);
    assert!(register.list(None, None).unwrap().is_empty());
    fs::remove_dir(spool.directory()).unwrap();
    let error = register.list(None, None).unwrap_err();
    assert_eq!(error, Error::Unreadable);
    assert_eq!(error.reason(), "records unreadable");
    assert_eq!(
        register
            .open(
                serde_json::from_value(opened("Refused")).unwrap(),
                &context()
            )
            .unwrap_err(),
        error
    );
}

#[cfg(unix)]
#[test]
fn write_failure_is_reported_without_a_saved_item_and_counts_an_error() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = Temp::new();
    let spool = RecordSpool::open(&tmp.0).unwrap();
    let register = Register::new(&spool);
    let recorder = metrics_exporter_prometheus::PrometheusBuilder::new().build_recorder();
    let handle = recorder.handle();
    let _recorder = metrics::set_default_local_recorder(&recorder);
    fs::set_permissions(spool.directory(), fs::Permissions::from_mode(0o500)).unwrap();
    let result = register.open(
        serde_json::from_value(opened("Synthetic")).unwrap(),
        &context(),
    );
    fs::set_permissions(spool.directory(), fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(result.unwrap_err().code(), "OPS_RECORD_WRITE_FAILED");
    assert!(register.list(None, None).unwrap().is_empty());
    assert!(!tmp.record(1).exists());
    assert!(
        handle
            .render()
            .contains("ops_cockpit_record_writes_total{outcome=\"error\"} 1")
    );
}
