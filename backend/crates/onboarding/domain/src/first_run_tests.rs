use crate::*;

#[test]
fn roles_can_be_prepared_or_skipped_and_counts_add_up_at_two_thousand_people() {
    let f = SetupFacts {
        phase_is_setup: true,
        entities: 5,
        workplaces: 40,
        org_units: 300,
        employees: 2000,
        unplaced_people: 18,
        entity_unknown_people: 3,
        non_ops_grants: 1,
        tenant_roles: 1,
        ..SetupFacts::default()
    };
    let c = checklist(&f);
    assert_eq!(c.summary.placed + c.summary.unplaced, c.summary.people);
    assert_eq!(c.summary.placed, 1982);
    let employees = c.steps.iter().find(|s| s.key == "employees").unwrap();
    assert_eq!(employees.counts.unplaced, 18);
    assert_eq!(employees.paths, ["one", "paste", "import"]);
    assert_eq!(employees.state, StepState::Attention);
    for (grant, skip, expected) in [
        (0, false, StepState::Todo),
        (1, false, StepState::Done),
        (0, true, StepState::Done),
    ] {
        let c = checklist(&SetupFacts {
            non_ops_grants: grant,
            roles_step_skipped: skip,
            ..f
        });
        assert_eq!(
            c.steps.iter().find(|s| s.key == "roles").unwrap().state,
            expected
        );
    }
}

#[test]
fn unplaced_people_are_a_warning_and_change_the_digest() {
    let f = SetupFacts {
        phase_is_setup: true,
        terms_accepted: true,
        entities: 1,
        workplaces: 1,
        org_units: 1,
        access_admin_holders: 1,
        employees: 2000,
        ..SetupFacts::default()
    };
    let before = preview(&f, &Records::new());
    let f = SetupFacts {
        unplaced_people: 18,
        ..f
    };
    let after = preview(&f, &Records::new());
    assert!(after.blockers.is_empty());
    assert!(backstop(&f, true, true, false, true).is_empty());
    assert!(after.warnings.iter().any(|i| i.code == "unplaced_people"
        && i.count == Some(18)
        && i.remedy == Some("place_people")));
    assert_ne!(before.digest, after.digest);
}

#[test]
fn no_access_admin_blocks_start_and_named_breakdown_is_bound_to_the_digest() {
    let f = SetupFacts {
        phase_is_setup: true,
        ..SetupFacts::default()
    };
    let p = preview(&f, &Records::new());
    assert!(
        p.blockers
            .iter()
            .any(|i| i.code == "no_access_admin" && i.remedy == Some("grant_access_admin"))
    );
    assert!(backstop(&f, true, true, false, true).contains(&"access_admin_holders"));
    let before = p.digest.clone();
    let p = p.with_details(PreviewDetails {
        breakdown: vec![Breakdown {
            kind: "legal_entity".into(),
            id: "e1".into(),
            name: "A".into(),
            legal_entity_id: "e1".into(),
            people: 2000,
            units: 300,
        }],
        ..PreviewDetails::default()
    });
    assert_ne!(before, p.digest);
    let mut changed = p.details.clone();
    changed.access_admin_holders.push(Account {
        id: "a1".into(),
        name: "Ops".into(),
    });
    assert_ne!(p.digest, p.clone().with_details(changed).digest);
}

#[test]
fn stale_line_comparison_is_digest_bound_and_includes_removed_warnings() {
    let before = preview(
        &SetupFacts {
            unplaced_people: 18,
            ..SetupFacts::default()
        },
        &Records::new(),
    );
    let after = preview(&SetupFacts::default(), &Records::new());
    assert_eq!(digest_lines(&before.line_digests), before.digest);
    let changed = changed_codes(&after, &before.digest, &before.line_digests);
    assert!(changed.contains(&"unplaced_people".to_owned()));
    assert!(changed.contains(&"facts".to_owned()));
    assert!(!changed.contains(&"breakdown".to_owned()));
    let mut forged = before.line_digests.clone();
    forged.insert("facts".into(), "0".repeat(64));
    assert_eq!(
        changed_codes(&after, &before.digest, &forged),
        after.line_digests.keys().cloned().collect::<Vec<_>>()
    );
}

#[test]
fn the_exact_terms_version_is_part_of_the_preview_digest() {
    let before = preview(&SetupFacts::default(), &Records::new()).with_details(PreviewDetails {
        terms_version: Some(TermsVersion {
            version: "v1".into(),
            sha256: "a".repeat(64),
        }),
        ..PreviewDetails::default()
    });
    let after = before.clone().with_details(PreviewDetails {
        terms_version: Some(TermsVersion {
            version: "v2".into(),
            sha256: "b".repeat(64),
        }),
        ..PreviewDetails::default()
    });
    assert_ne!(before.digest, after.digest);
    assert_eq!(
        changed_codes(&after, &before.digest, &before.line_digests),
        ["terms_version"]
    );
}

#[test]
fn an_unresolved_department_has_its_own_remedy_without_counting_as_unplaced() {
    let f = SetupFacts {
        workplaces: 1,
        employees: 1,
        unresolved_departments: 1,
        ..Default::default()
    };
    let c = checklist(&f);
    let employees = c.steps.iter().find(|s| s.key == "employees").unwrap();
    assert_eq!(employees.remedy, Some("assign_departments"));
    assert_eq!(employees.state, crate::StepState::Attention);
    assert_eq!(c.summary.unplaced, 0);
    let preview = preview(&f, &crate::Records::new());
    let warning = preview
        .warnings
        .iter()
        .find(|w| w.code == "unresolved_departments")
        .unwrap();
    assert_eq!(warning.remedy, Some("assign_departments"));
    assert!(!preview.warnings.iter().any(|w| w.code == "unplaced_people"));
}
