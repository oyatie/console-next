//! Tests of [`super`] (preview.rs).
use super::*;

#[test]
fn legacy_company_text_mapping_is_fixed_through_placement() {
    let f = SetupFacts {
        unmapped_assignments: 1,
        ..ready()
    };
    let p = preview(&f, &Records::new());
    let mapping = p
        .warnings
        .iter()
        .find(|w| w.code == "company_names_to_map")
        .unwrap();
    assert_eq!(mapping.count, Some(1));
    assert_eq!(mapping.remedy, Some("place_people"));
}

#[test]
fn regression_bl014_preview_explains_setup_undo_becomes_correction() {
    assert!(
        preview(&ready(), &Records::new())
            .becomes_governed
            .contains(&"setup_undo_becomes_correction")
    );
}

pub(crate) fn ready() -> SetupFacts {
    SetupFacts {
        phase_is_setup: true,
        terms_accepted: true,
        entities: 1,
        registrations: 1,
        workplaces: 1,
        org_units: 1,
        org_change_approvers: 1,
        org_change_routed: true,
        employees: 1,
        own_passkeys: 2,
        access_admin_holders: 1,
        ..SetupFacts::default()
    }
}

fn workplace(id: &str, name: &str) -> Record {
    Record {
        kind: "workplace".to_owned(),
        id: id.to_owned(),
        name: name.to_owned(),
        legal_entity_id: "e1".to_owned(),
    }
}

#[test]
fn department_is_required_by_preview_and_backstop_even_after_a_legacy_skip() {
    for org_change_routed in [false, true] {
        for org_step_skipped in [false, true] {
            let mut f = SetupFacts {
                org_units: 0,
                org_step_skipped,
                org_change_routed,
                ..ready()
            };
            let missing = preview(&f, &Records::new());
            assert_eq!(
                missing.blockers,
                vec![item("no_department", 0, "add_department")]
            );
            assert!(!missing.warnings.iter().any(|w| w.code == "no_department"));
            assert_eq!(backstop(&f, true, true, true, true), vec!["org_units"]);

            f.org_units = 1;
            let present = preview(&f, &Records::new());
            assert!(present.blockers.is_empty());
            assert!(backstop(&f, true, true, true, true).is_empty());
            assert_ne!(missing.digest, present.digest);
        }
    }
}

#[test]
fn regression_company_49_no_line_about_a_capability_that_does_not_exist() {
    // The #7 contact store is not built: the preview says nothing about it.
    let p = preview(&ready(), &Records::new());
    let codes: Vec<_> = p.warnings.iter().map(|w| w.code).collect();
    assert!(
        !codes.iter().any(|c| c.starts_with("security_contact")),
        "{codes:?}"
    );
}

#[test]
fn regression_company_53_each_line_carries_its_records_and_they_are_in_the_digest() {
    let f = SetupFacts {
        workplaces_incomplete: 1,
        insurance_not_established_with_people: 1,
        ..ready()
    };
    let mut r = Records::new();
    r.insert(
        "workplace_incomplete".to_owned(),
        vec![workplace("w4", "오송공장")],
    );
    r.insert(
        "insurance_not_established_with_people".to_owned(),
        vec![workplace("w4", "오송공장")],
    );
    let p = preview(&f, &r);
    assert_eq!(p.blockers[0].records, vec![workplace("w4", "오송공장")]);
    let ins = p
        .warnings
        .iter()
        .find(|w| w.code == "insurance_not_established_with_people")
        .unwrap();
    assert_eq!((ins.count, ins.records.len()), (Some(1), 1));
    r.insert(
        "workplace_incomplete".to_owned(),
        vec![workplace("w5", "평택공장")],
    );
    assert_ne!(preview(&f, &r).digest, p.digest);
}

#[test]
fn regression_governance_20_one_passkey_is_a_warning_never_a_blocker() {
    let one = SetupFacts {
        own_passkeys: 1,
        ..ready()
    };
    let p = preview(&one, &Records::new());
    assert!(p.blockers.is_empty());
    let single = p
        .warnings
        .iter()
        .find(|w| w.code == "single_passkey")
        .unwrap();
    assert_eq!(single.remedy, Some("add_passkey"));
    let two = preview(&ready(), &Records::new());
    assert!(!two.warnings.iter().any(|w| w.code == "single_passkey"));
    assert!(backstop(&one, true, true, true, true).is_empty());
}

#[test]
fn regression_w10_under_approval_policy_none_a_solo_tenant_needs_no_approver() {
    let none = SetupFacts {
        org_change_routed: false,
        org_change_approvers: 0,
        ..ready()
    };
    let p = preview(&none, &Records::new());
    assert!(p.blockers.is_empty(), "{:?}", p.blockers);
    let codes: Vec<_> = p.warnings.iter().map(|w| w.code).collect();
    assert!(!codes.contains(&"org_change_needs_second_person_after_go_live"));
    // regression (W10): no sole-holder tick is asked for or required.
    assert!(!codes.contains(&"sole_holder"), "{codes:?}");
    assert_eq!(
        p.becomes_governed[0],
        "org_structure_changes_through_proposals"
    );
    assert!(backstop(&none, true, true, false, true).is_empty());
}

#[test]
fn a_ready_solo_tenant_has_no_blockers_but_is_told_about_the_gap() {
    let p = preview(&ready(), &Records::new());
    assert!(p.blockers.is_empty(), "{:?}", p.blockers);
    let codes: Vec<_> = p.warnings.iter().map(|w| w.code).collect();
    assert!(codes.contains(&"sole_holder"));
    assert!(codes.contains(&"org_change_needs_second_person_after_go_live"));
    assert_eq!(p.digest.len(), 64);
    assert!(backstop(&ready(), true, true, true, true).is_empty());
    assert_eq!(
        backstop(&ready(), true, true, false, true),
        vec!["sole_holder_acknowledged"]
    );
}

#[test]
fn every_blocker_names_its_fix_and_changes_the_digest() {
    let empty = SetupFacts {
        phase_is_setup: true,
        org_change_routed: true,
        ..SetupFacts::default()
    };
    let p = preview(&empty, &Records::new());
    assert!(p.blockers.iter().all(|b| b.remedy.is_some()));
    let codes: Vec<_> = p.blockers.iter().map(|b| b.code).collect();
    assert_eq!(
        codes,
        vec![
            "terms_not_accepted",
            "no_access_admin",
            "no_legal_entity",
            "no_department",
            "no_org_change_approver"
        ]
    );
    assert_ne!(preview(&ready(), &Records::new()).digest, p.digest);
    let staffed = SetupFacts {
        staffed_workplaces_without_registration: 1,
        ..ready()
    };
    let p = preview(&staffed, &Records::new());
    assert!(p.blockers.is_empty());
    assert!(
        !p.warnings
            .iter()
            .any(|item| item.code.contains("without_registration"))
    );
    assert!(staffed.primary_workplaces_ready());
    // Empty and staffed workplaces share the same optional registration answer.
    let empty_wp = SetupFacts {
        empty_workplaces_without_registration: 1,
        ..ready()
    };
    assert!(preview(&empty_wp, &Records::new()).blockers.is_empty());
}

#[test]
fn staffed_people_without_department_block_even_after_the_org_step_was_skipped() {
    for org_step_skipped in [false, true] {
        let mut f = SetupFacts {
            employees: 3,
            people_without_department: 2,
            org_step_skipped,
            ..ready()
        };
        let records = Records::from([(
            "people_without_department".into(),
            vec![
                Record {
                    kind: "employee".into(),
                    id: "b".into(),
                    name: "B".into(),
                    legal_entity_id: "e".into(),
                },
                Record {
                    kind: "employee".into(),
                    id: "c".into(),
                    name: "C".into(),
                    legal_entity_id: "e".into(),
                },
            ],
        )]);
        let p = preview(&f, &records);
        assert_eq!(p.blockers.len(), 1);
        assert_eq!(
            (
                p.blockers[0].code,
                p.blockers[0].count,
                p.blockers[0].remedy
            ),
            (
                "people_without_department",
                Some(2),
                Some("assign_department")
            )
        );
        assert_eq!(p.blockers[0].records.len(), 2);
        assert_eq!(
            backstop(&f, true, true, true, true),
            ["people_without_department"]
        );
        f.people_without_department = 0;
        assert!(preview(&f, &Records::new()).blockers.is_empty());
        assert!(backstop(&f, true, true, true, true).is_empty());
        f.org_units = 0;
        assert_eq!(
            preview(&f, &Records::new()).blockers[0].code,
            "no_department"
        );
    }
}

#[test]
fn setup_department_blocker_does_not_also_offer_an_unplaced_start_warning() {
    let f = SetupFacts {
        people_without_department: 2,
        unplaced_people: 2,
        unresolved_departments: 2,
        ..ready()
    };
    let p = preview(&f, &Records::new());
    assert!(
        p.blockers
            .iter()
            .any(|i| i.code == "people_without_department")
    );
    assert!(
        !p.warnings
            .iter()
            .any(|i| matches!(i.code, "unplaced_people" | "unresolved_departments"))
    );
    let operating = preview(
        &SetupFacts {
            phase_is_setup: false,
            ..f
        },
        &Records::new(),
    );
    assert!(
        !operating
            .blockers
            .iter()
            .any(|i| i.code == "people_without_department")
    );
    assert!(
        operating
            .warnings
            .iter()
            .any(|i| i.code == "unplaced_people")
    );
}
