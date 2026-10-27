// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::panic)]
use super::*;
use std::{cell::Cell, io, panic::AssertUnwindSafe};

#[path = "../tests/support/mod.rs"]
mod support;
use support::Temp;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Failure {
    TornWrite,
    CommitSync,
    RollbackRemove,
    RollbackSync,
}

thread_local! {
    static FAILURE: Cell<Option<Failure>> = const { Cell::new(None) };
}

pub(super) fn interrupt_write(file: &mut File) {
    if FAILURE.get() == Some(Failure::TornWrite) {
        file.write_all(b"{\"v\":").unwrap();
        // Unwinding skips rollback, as an interrupted process would.
        panic!("simulated interruption during the record write");
    }
}

pub(super) fn fail(point: Failure) -> io::Result<()> {
    let failure = FAILURE.get();
    if failure == Some(point)
        || (point == Failure::CommitSync
            && matches!(
                failure,
                Some(Failure::RollbackRemove | Failure::RollbackSync)
            ))
    {
        Err(io::Error::other("synthetic filesystem failure"))
    } else {
        Ok(())
    }
}

fn append(spool: &RecordSpool) -> Result<Record, AppendError<()>> {
    spool.append("synthetic-support-ref", |_| {
        Ok(
            serde_json::json!({"obligation_id": "synthetic", "event": "opened"})
                .as_object()
                .unwrap()
                .clone(),
        )
    })
}

#[test]
fn an_interrupted_write_leaves_only_a_torn_temporary_file_and_can_be_retried() {
    let tmp = Temp::new();
    let spool = RecordSpool::open(&tmp.0).unwrap();
    let first = append(&spool).unwrap();
    FAILURE.set(Some(Failure::TornWrite));
    let interrupted = std::panic::catch_unwind(AssertUnwindSafe(|| append(&spool)));
    FAILURE.set(None);
    assert!(interrupted.is_err());
    drop(spool);
    assert!(!tmp.record(2).exists());
    let pending = tmp.0.join(".obligations-pending");
    assert_eq!(fs::read(&pending).unwrap(), b"{\"v\":");
    let reopened = RecordSpool::open(&tmp.0).unwrap();
    assert_eq!(reopened.read().unwrap(), vec![first.clone()]);
    let second = append(&reopened).unwrap();
    assert_eq!(second.document["seq"], 2);
    assert_eq!(second.document["prev"], first.hash);
    assert!(!pending.exists());
    assert_eq!(reopened.read().unwrap(), vec![first, second]);
}

#[test]
fn a_failed_commit_sync_rolls_back_the_published_record_and_allows_retry() {
    let tmp = Temp::new();
    let spool = RecordSpool::open(&tmp.0).unwrap();
    FAILURE.set(Some(Failure::CommitSync));
    let result = append(&spool);
    FAILURE.set(None);
    assert!(matches!(
        result,
        Err(AppendError::Storage(SpoolError::WriteFailed))
    ));
    assert!(!tmp.record(1).exists());
    assert!(spool.read().unwrap().is_empty());
    assert_eq!(append(&spool).unwrap().document["seq"], 1);
}

fn assert_uncertain_rollback_refuses_reads_and_writes(failure: Failure) {
    let tmp = Temp::new();
    let spool = RecordSpool::open(&tmp.0).unwrap();
    FAILURE.set(Some(failure));
    let result = append(&spool);
    FAILURE.set(None);
    assert!(matches!(
        result,
        Err(AppendError::Storage(SpoolError::WriteFailed))
    ));
    assert_eq!(tmp.record(1).exists(), failure == Failure::RollbackRemove);
    // Even repairing the visible file cannot establish that rollback was durable.
    if tmp.record(1).exists() {
        fs::remove_file(tmp.record(1)).unwrap();
    }
    assert_eq!(spool.read().unwrap_err(), SpoolError::Unreadable);
    assert!(matches!(
        spool.append("synthetic-support-ref", |_| -> Result<_, ()> {
            panic!("uncertain storage must refuse before application validation")
        }),
        Err(AppendError::Storage(SpoolError::Unreadable))
    ));
    assert!(!tmp.record(1).exists());
}

#[test]
fn an_unremovable_record_makes_rollback_uncertain() {
    assert_uncertain_rollback_refuses_reads_and_writes(Failure::RollbackRemove);
}

#[test]
fn an_unsynced_removal_makes_rollback_uncertain() {
    assert_uncertain_rollback_refuses_reads_and_writes(Failure::RollbackSync);
}
