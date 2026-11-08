// SPDX-License-Identifier: LicenseRef-Proprietary
use super::tests::ready;
use super::*;

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
