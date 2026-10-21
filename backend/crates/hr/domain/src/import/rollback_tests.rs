// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]

use super::*;
use time::{Duration, macros::datetime};

#[test]
fn basis_is_phase_aware_and_measures_the_window_at_filing() {
    let applied = datetime!(2026-10-01 0:00 UTC);
    let deadline = applied + Duration::days(14);
    assert_eq!(basis(true, applied, deadline, 14, true), Ok(Basis::Direct));
    assert_eq!(basis(false, applied, applied, 14, false), Ok(Basis::StepUp));
    assert_eq!(
        basis(false, applied, applied, 14, true),
        Ok(Basis::SecondPerson)
    );
    assert_eq!(
        basis(
            false,
            applied,
            deadline - Duration::nanoseconds(1),
            14,
            false
        ),
        Ok(Basis::StepUp)
    );
    assert_eq!(
        basis(false, applied, deadline, 14, false),
        Err("import_rollback_window_closed")
    );
    assert_eq!(
        basis(false, applied, applied + Duration::days(3), 3, false),
        Err("import_rollback_window_closed")
    );
    assert_eq!(
        basis(true, applied, applied + Duration::days(90), 3, true),
        Ok(Basis::Direct)
    );
    assert_eq!(
        basis(
            false,
            applied,
            deadline + Duration::nanoseconds(1),
            14,
            true
        ),
        Err("import_rollback_window_closed")
    );
}

#[test]
fn every_dependency_blocks_and_a_runs_own_work_does_not() {
    let run = uuid::Uuid::from_u128(7);
    let mut facts = Dependencies::default();
    assert!(facts.kinds(run, true).is_empty());
    for kind in [
        BlockerKind::WorkRecord,
        BlockerKind::ChangedSince,
        BlockerKind::LaterRun,
        BlockerKind::AccountLinked,
    ] {
        facts = Dependencies::default();
        match kind {
            BlockerKind::WorkRecord => facts.work_record_runs.push(None),
            BlockerKind::ChangedSince => facts.changed_since = true,
            BlockerKind::LaterRun => facts.later_run = true,
            BlockerKind::AccountLinked => facts.account_linked = true,
        }
        assert_eq!(facts.kinds(run, true), vec![kind]);
    }
    assert!(
        Dependencies {
            account_linked: true,
            work_record_runs: vec![None],
            ..Default::default()
        }
        .kinds(run, false)
        .is_empty()
    );
    // The setup 휴직, ONBOARD and employment are all tagged with this run.
    let mut own = Dependencies {
        work_record_runs: vec![Some(run); 3],
        ..Default::default()
    };
    assert!(own.kinds(run, true).is_empty());
    own.work_record_runs.push(Some(uuid::Uuid::from_u128(8)));
    assert_eq!(own.kinds(run, true), vec![BlockerKind::WorkRecord]);
}

#[test]
fn digest_binds_inverse_values_effects_and_blockers_independently_of_order() {
    let a = InverseRow {
        employee_id: uuid::Uuid::from_u128(1),
        employee_number: Some("S-001".into()),
        inserted: false,
        fields: vec![InverseField {
            field: "position".into(),
            current: Some("B".into()),
            before: Some("A".into()),
        }],
        effects: vec!["profile_created".into(), "rrn_recorded".into()],
    };
    let b = InverseRow {
        employee_id: uuid::Uuid::from_u128(2),
        employee_number: Some("S-002".into()),
        inserted: true,
        fields: vec![],
        effects: vec!["onboard_scheduled".into()],
    };
    let digest = preview_digest(&[a.clone(), b.clone()], &[]).unwrap();
    assert_eq!(digest.len(), 64);
    assert_eq!(
        digest,
        preview_digest(&[b.clone(), a.clone()], &[]).unwrap()
    );
    let mut reordered = a.clone();
    reordered.effects.reverse();
    assert_eq!(
        digest,
        preview_digest(&[reordered, b.clone()], &[]).unwrap()
    );
    let mut changed = a.clone();
    changed.fields[0].before = None;
    assert_ne!(digest, preview_digest(&[changed, b.clone()], &[]).unwrap());
    let mut changed = a.clone();
    changed.fields[0].current = None;
    assert_ne!(digest, preview_digest(&[changed, b.clone()], &[]).unwrap());
    let mut changed = a.clone();
    changed.effects.pop();
    assert_ne!(digest, preview_digest(&[changed, b.clone()], &[]).unwrap());
    let blocker = Blocker {
        employee_id: a.employee_id,
        employee_number: a.employee_number.clone(),
        kind: BlockerKind::ChangedSince,
        field: Some("position".into()),
        record: a.employee_id.to_string(),
        since: "2026-10-02T00:00:00Z".into(),
    };
    assert_ne!(
        digest,
        preview_digest(&[a.clone(), b.clone()], std::slice::from_ref(&blocker)).unwrap()
    );
    let mut other = blocker.clone();
    other.employee_id = b.employee_id;
    let rows = [a, b];
    assert_eq!(
        preview_digest(&rows, &[blocker.clone(), other.clone()]).unwrap(),
        preview_digest(&rows, &[other, blocker]).unwrap()
    );
}

#[test]
fn run_state_refusals_do_not_admit_an_unreversible_run() {
    for (status, ledger, pending, code) in [
        ("PREVIEWED", true, false, "import_run_not_applied"),
        ("DRY_RUN", true, false, "import_run_not_applied"),
        ("FAILED", true, false, "import_run_not_applied"),
        ("ROLLED_BACK", true, false, "import_run_already_rolled_back"),
        ("APPLIED", false, false, "import_run_predates_ledger"),
        ("APPLIED", true, true, "import_rollback_pending"),
    ] {
        assert_eq!(check_run(status, ledger, pending), Err(code));
    }
    assert_eq!(check_run("APPLIED", true, false), Ok(()));
}

#[test]
fn field_blockers_replace_only_the_same_persons_general_change_blocker() {
    let person = Uuid::from_u128(1);
    let other_person = Uuid::from_u128(2);
    let general = Blocker {
        employee_id: person,
        employee_number: None,
        kind: BlockerKind::ChangedSince,
        field: None,
        record: format!("/people/{person}"),
        since: "2026-10-02T00:00:00Z".into(),
    };
    let mut job = general.clone();
    job.field = Some("job".into());
    let mut position = general.clone();
    position.field = Some("position".into());
    let mut other = general.clone();
    other.employee_id = other_person;
    let mut blockers = vec![general, job.clone(), position, other];
    for kind in [
        BlockerKind::WorkRecord,
        BlockerKind::LaterRun,
        BlockerKind::AccountLinked,
    ] {
        let mut blocker = job.clone();
        blocker.kind = kind;
        blocker.field = None;
        blockers.push(blocker);
    }
    let expected = blockers[1..].to_vec();
    remove_redundant_changed_since(&mut blockers);
    assert_eq!(blockers, expected);
}
