// SPDX-License-Identifier: LicenseRef-Proprietary
use super::tests::ready;
use super::*;
use crate::{StepState, checklist};

#[test]
fn missing_entity_registration_blocks_setup_and_is_bound_to_the_preview() {
    let mut f = SetupFacts {
        entities: 2,
        entities_without_registration: 1,
        ..ready()
    };
    let record = Record {
        kind: "legal_entity".into(),
        id: "e2".into(),
        name: "미등록 법인".into(),
        legal_entity_id: "e2".into(),
    };
    let records = Records::from([("entity_without_registration".into(), vec![record.clone()])]);
    let missing = preview(&f, &records);
    assert_eq!(missing.blockers.len(), 1);
    let blocker = &missing.blockers[0];
    assert_eq!(blocker.code, "entity_without_registration");
    assert_eq!(blocker.count, Some(1));
    assert_eq!(blocker.remedy, Some("add_registration"));
    assert_eq!(blocker.records, [record]);
    assert!(!f.entities_ready());
    assert!(backstop(&f, true, true, true, true).contains(&"entities_without_registration"));

    f.entities_without_registration = 0;
    let fixed = preview(&f, &Records::new());
    assert!(fixed.blockers.is_empty());
    assert!(f.entities_ready());
    assert!(backstop(&f, true, true, true, true).is_empty());
    assert_ne!(missing.digest, fixed.digest);

    f.entities_without_registration = 1;
    f.phase_is_setup = false;
    assert!(
        !preview(&f, &records)
            .blockers
            .iter()
            .any(|b| b.code == "entity_without_registration")
    );
}

#[test]
fn entity_step_requires_the_missing_registration_before_confirmation() {
    let mut f = SetupFacts {
        entities: 2,
        entities_without_registration: 1,
        entities_needing_confirmation: 1,
        registrations_needing_confirmation: 1,
        phase_is_setup: true,
        ..SetupFacts::default()
    };
    let entity = |f: &SetupFacts| checklist(f).steps.remove(0);
    let missing = entity(&f);
    assert_eq!(missing.state, StepState::Todo);
    assert_eq!(missing.action, "add_registration");
    assert_eq!(missing.remedy, Some("add_registration"));
    assert_eq!(missing.count, Some(1));
    let blocked = checklist(&f);

    f.entities_without_registration = 0;
    let confirmation = entity(&f);
    assert_eq!(confirmation.state, StepState::Attention);
    assert_eq!(confirmation.remedy, Some("confirm_legal_entity"));
    assert_eq!(confirmation.count, Some(2));
    assert_eq!(checklist(&f).done, blocked.done + 1);

    f.entities_needing_confirmation = 0;
    f.registrations_needing_confirmation = 0;
    assert_eq!(entity(&f).state, StepState::Done);
    f.entities_without_registration = 1;
    f.phase_is_setup = false;
    assert_eq!(entity(&f).state, StepState::Done);
}
