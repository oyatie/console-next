// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used)]
use std::{fs, sync::Arc};

use console_ops_adapter_fs::{AppendError, RecordSpool, SpoolError};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

mod support;
use support::Temp;

fn opened(id: &str) -> Map<String, Value> {
    json!({
        "at": "2026-10-27T00:00:00Z",
        "operator": {"person": "00000000-0000-4000-8000-000000000001", "method": "access"},
        "support_ref": "synthetic-support-ref",
        "obligation_id": id,
        "event": "opened",
        "fields": {"kind": "drill", "reviewer_role": "owner", "title": "Synthetic restore drill"}
    })
    .as_object()
    .unwrap()
    .clone()
}

fn append(spool: &RecordSpool, id: &str) {
    spool
        .append("synthetic-support-ref", |_| Ok::<_, ()>(opened(id)))
        .unwrap();
}

#[test]
fn empty_spool_checks_the_configured_obligations_prefix() {
    let tmp = Temp::new();
    let spool = RecordSpool::open(&tmp.0).unwrap();
    assert_eq!(spool.directory(), tmp.0.join("obligations"));
    assert!(spool.read().unwrap().is_empty());
}

#[test]
fn a_missing_configured_records_mount_is_not_created() {
    let tmp = Temp::new();
    let missing = tmp.0.join("missing-mount");
    assert!(matches!(
        RecordSpool::open(&missing),
        Err(SpoolError::Unreadable)
    ));
    assert!(!missing.exists());
}

#[test]
fn records_are_create_only_and_hash_the_exact_preceding_bytes() {
    let tmp = Temp::new();
    let spool = RecordSpool::open(&tmp.0).unwrap();
    append(&spool, "first");
    let original = fs::read(tmp.record(1)).unwrap();
    append(&spool, "second");
    let records = spool.read().unwrap();
    assert_eq!(records.len(), 2);
    assert_eq!(records[0].document["v"], 1);
    assert_eq!(records[0].document["seq"], 1);
    assert_eq!(records[0].document["prev"], "genesis");
    assert_eq!(records[0].document["operator"]["method"], "access");
    assert_eq!(records[0].document["at"], "2026-10-27T00:00:00Z");
    assert_eq!(records[1].document["seq"], 2);
    assert_eq!(
        records[1].document["prev"],
        hex::encode(Sha256::digest(&original))
    );
    assert_eq!(records[0].hash, hex::encode(Sha256::digest(&original)));
    assert_eq!(fs::read(tmp.record(1)).unwrap(), original);
    assert!(!original.contains(&b'\n'));
    assert_eq!(RecordSpool::open(&tmp.0).unwrap().read().unwrap(), records);
}

#[test]
fn ops_record_chain_broken_on_unparsable_record_three() {
    let tmp = Temp::new();
    let spool = RecordSpool::open(&tmp.0).unwrap();
    let recorder = metrics_exporter_prometheus::PrometheusBuilder::new().build_recorder();
    let handle = recorder.handle();
    let _recorder = metrics::set_default_local_recorder(&recorder);
    for n in 1..=5 {
        append(&spool, &n.to_string());
    }
    let mut bytes = fs::read(tmp.record(3)).unwrap();
    bytes[0] = b'!';
    fs::write(tmp.record(3), bytes).unwrap();
    assert_eq!(spool.read().unwrap_err(), SpoolError::ChainBroken(3));
    assert!(matches!(
        spool.append("synthetic-support-ref", |_| Ok::<_, ()>(opened("refused"))),
        Err(AppendError::Storage(SpoolError::ChainBroken(3)))
    ));
    assert!(!tmp.record(6).exists());
    assert!(matches!(
        RecordSpool::open(&tmp.0),
        Err(SpoolError::ChainBroken(3))
    ));
    assert!(
        handle
            .render()
            .contains("ops_cockpit_record_verifications_total{outcome=\"error\"} 3")
    );
}

#[test]
fn a_valid_json_edit_is_detected_at_the_preceding_record() {
    let tmp = Temp::new();
    let spool = RecordSpool::open(&tmp.0).unwrap();
    for n in 1..=5 {
        append(&spool, &n.to_string());
    }
    let mut doc: Value = serde_json::from_slice(&fs::read(tmp.record(3)).unwrap()).unwrap();
    doc["fields"]["title"] = "Edited".into();
    fs::write(tmp.record(3), serde_json::to_vec(&doc).unwrap()).unwrap();
    assert_eq!(spool.read().unwrap_err(), SpoolError::ChainBroken(3));
}

#[test]
fn deleting_record_four_refuses_reads_and_writes() {
    let tmp = Temp::new();
    let spool = RecordSpool::open(&tmp.0).unwrap();
    for n in 1..=5 {
        append(&spool, &n.to_string());
    }
    fs::remove_file(tmp.record(4)).unwrap();
    assert_eq!(spool.read().unwrap_err(), SpoolError::ChainBroken(4));
    assert!(matches!(
        spool.append("synthetic-support-ref", |_| Ok::<_, ()>(opened("refused"))),
        Err(AppendError::Storage(SpoolError::ChainBroken(4)))
    ));
}

#[test]
fn persisted_sequence_version_and_genesis_are_verified() {
    for (key, value) in [("seq", json!(2)), ("v", json!(2)), ("prev", json!("bad"))] {
        let tmp = Temp::new();
        let spool = RecordSpool::open(&tmp.0).unwrap();
        append(&spool, "first");
        let mut doc: Value = serde_json::from_slice(&fs::read(tmp.record(1)).unwrap()).unwrap();
        doc[key] = value;
        fs::write(tmp.record(1), serde_json::to_vec(&doc).unwrap()).unwrap();
        assert_eq!(spool.read().unwrap_err(), SpoolError::ChainBroken(1));
    }
}

#[test]
fn application_refusal_creates_no_file() {
    let tmp = Temp::new();
    let spool = RecordSpool::open(&tmp.0).unwrap();
    let result = spool.append("synthetic-support-ref", |records| {
        assert!(records.is_empty());
        Err::<Map<String, Value>, _>("OPS_OBLIGATION_INCOMPLETE")
    });
    assert!(matches!(
        result,
        Err(AppendError::Rejected("OPS_OBLIGATION_INCOMPLETE"))
    ));
    assert!(spool.read().unwrap().is_empty());
    assert!(!tmp.record(1).exists());
}

#[test]
fn concurrent_validation_and_append_share_one_process_mutex() {
    let tmp = Temp::new();
    let spool = Arc::new(RecordSpool::open(&tmp.0).unwrap());
    let workers: Vec<_> = (0..12)
        .map(|_| {
            let spool = Arc::clone(&spool);
            std::thread::spawn(move || {
                spool.append("synthetic-support-ref", |records| {
                    if records.is_empty() {
                        Ok(opened("only-one"))
                    } else {
                        Err("already opened")
                    }
                })
            })
        })
        .collect();
    let saved = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .filter(Result::is_ok)
        .count();
    assert_eq!(saved, 1);
    assert_eq!(spool.read().unwrap().len(), 1);
}

#[cfg(unix)]
#[test]
fn ops_record_write_failed_on_read_only_directory_counts_error_without_saving() {
    use std::os::unix::fs::PermissionsExt;
    let euid = std::process::Command::new("id").arg("-u").output().unwrap();
    assert!(euid.status.success());
    if String::from_utf8(euid.stdout).unwrap().trim() == "0" {
        eprintln!("skipped: euid 0 bypasses directory write permissions");
        return;
    }
    let tmp = Temp::new();
    let spool = RecordSpool::open(&tmp.0).unwrap();
    let recorder = metrics_exporter_prometheus::PrometheusBuilder::new().build_recorder();
    let handle = recorder.handle();
    let _recorder = metrics::set_default_local_recorder(&recorder);
    fs::set_permissions(spool.directory(), fs::Permissions::from_mode(0o500)).unwrap();
    let result = spool.append("synthetic-support-ref", |_| Ok::<_, ()>(opened("refused")));
    fs::set_permissions(spool.directory(), fs::Permissions::from_mode(0o700)).unwrap();
    assert!(matches!(
        result,
        Err(AppendError::Storage(SpoolError::WriteFailed))
    ));
    assert!(spool.read().unwrap().is_empty());
    assert!(!tmp.record(1).exists());
    assert!(
        handle
            .render()
            .contains("ops_cockpit_record_writes_total{outcome=\"error\"} 1")
    );
}

#[cfg(unix)]
#[test]
fn symlinks_and_unexpected_entries_are_never_followed_or_overwritten() {
    use std::os::unix::fs::symlink;
    let tmp = Temp::new();
    let spool = RecordSpool::open(&tmp.0).unwrap();
    let outside = tmp.0.join("outside");
    fs::write(&outside, b"untouched").unwrap();
    symlink(&outside, tmp.record(1)).unwrap();
    assert_eq!(spool.read().unwrap_err(), SpoolError::ChainBroken(1));
    assert!(
        spool
            .append("synthetic-support-ref", |_| Ok::<_, ()>(opened("refused")))
            .is_err()
    );
    assert_eq!(fs::read(&outside).unwrap(), b"untouched");
    fs::remove_file(tmp.record(1)).unwrap();
    fs::write(spool.directory().join("unexpected.json"), b"{}").unwrap();
    assert_eq!(spool.read().unwrap_err(), SpoolError::Unreadable);
}

#[test]
fn storage_metadata_cannot_be_spoofed_by_the_application() {
    let tmp = Temp::new();
    let spool = RecordSpool::open(&tmp.0).unwrap();
    let record = spool
        .append("trusted-reference", |_| {
            let mut document = opened("first");
            for key in ["v", "seq", "prev", "support_ref"] {
                document.insert(key.into(), json!("spoofed"));
            }
            Ok::<_, ()>(document)
        })
        .unwrap();
    assert_eq!(record.document["v"], 1);
    assert_eq!(record.document["seq"], 1);
    assert_eq!(record.document["prev"], "genesis");
    assert_eq!(record.document["support_ref"], "trusted-reference");
    assert_eq!(spool.read().unwrap(), vec![record]);
}

#[test]
fn create_new_refuses_a_file_that_appears_after_verification() {
    let tmp = Temp::new();
    let spool = RecordSpool::open(&tmp.0).unwrap();
    let result = spool.append("synthetic-support-ref", |_| {
        fs::write(tmp.record(1), b"existing file").unwrap();
        Ok::<_, ()>(opened("refused"))
    });
    assert!(matches!(
        result,
        Err(AppendError::Storage(SpoolError::WriteFailed))
    ));
    assert_eq!(fs::read(tmp.record(1)).unwrap(), b"existing file");
}

#[test]
fn an_unreadable_spool_never_returns_an_empty_success() {
    let tmp = Temp::new();
    let spool = RecordSpool::open(&tmp.0).unwrap();
    fs::remove_dir(spool.directory()).unwrap();
    assert_eq!(spool.read().unwrap_err(), SpoolError::Unreadable);
    assert!(matches!(
        spool.append("synthetic-support-ref", |_| Ok::<_, ()>(opened("refused"))),
        Err(AppendError::Storage(SpoolError::Unreadable))
    ));
}

#[cfg(unix)]
#[test]
fn a_symlinked_obligations_directory_is_refused_at_startup_read_and_append() {
    use std::os::unix::fs::symlink;
    let tmp = Temp::new();
    let spool = RecordSpool::open(&tmp.0).unwrap();
    let outside = tmp.0.join("outside");
    fs::rename(spool.directory(), &outside).unwrap();
    symlink(&outside, spool.directory()).unwrap();
    assert!(matches!(
        RecordSpool::open(&tmp.0),
        Err(SpoolError::Unreadable)
    ));
    assert_eq!(spool.read().unwrap_err(), SpoolError::Unreadable);
    assert!(matches!(
        spool.append("synthetic-support-ref", |_| Ok::<_, ()>(opened("refused"))),
        Err(AppendError::Storage(SpoolError::Unreadable))
    ));
    assert!(fs::read_dir(&outside).unwrap().next().is_none());
}
