//! Tests of [`super`] (checklist.rs).
use super::*;

#[test]
fn regression_bl013_roles_follow_employees_and_entity_action_names_registration() {
    let c = checklist(&SetupFacts {
        phase_is_setup: true,
        ..SetupFacts::default()
    });
    assert_eq!(c.steps[0].action, "register_legal_entity");
    let keys: Vec<_> = c.steps.iter().map(|s| s.key).collect();
    let at = keys.iter().position(|k| *k == "employees").unwrap();
    assert_eq!(&keys[at + 1..], &["roles", "golive"]);
    assert!(c.steps[at + 1].skippable);
}

#[test]
fn an_empty_tenant_starts_at_the_certificate_and_blocks_downstream_with_fixes() {
    let f = SetupFacts {
        phase_is_setup: true,
        org_change_approvers: 1,
        org_change_routed: true,
        ..SetupFacts::default()
    };
    let c = checklist(&f);
    let states: Vec<_> = c.steps.iter().map(|s| (s.key, s.state, s.remedy)).collect();
    assert_eq!(states[0], ("entity", StepState::Todo, None));
    assert_eq!(
        states[1],
        ("workplace", StepState::Blocked, Some("create_legal_entity"))
    );
    assert_eq!(
        states[5],
        ("employees", StepState::Blocked, Some("create_workplace"))
    );
    assert_eq!(states[4], ("passkey", StepState::Todo, None));
    assert!(
        c.steps
            .iter()
            .filter(|s| s.state == StepState::Blocked)
            .all(|s| s.remedy.is_some())
    );
}

#[test]
fn regression_w10_org_units_and_deferring_people_complete_their_steps() {
    let f = SetupFacts {
        phase_is_setup: true,
        terms_accepted: true,
        entities: 1,
        registrations: 1,
        workplaces: 1,
        org_units: 1,
        org_change_approvers: 1,
        employees_step_deferred: true,
        access_admin_holders: 1,
        ..SetupFacts::default()
    };
    let c = checklist(&f);
    let keys: Vec<_> = c.steps.iter().map(|s| s.key).collect();
    // regression (W10): approval.policy.org_structure = none shows no 결재선 step.
    assert_eq!(
        keys,
        [
            "entity",
            "workplace",
            "org",
            "passkey",
            "employees",
            "roles",
            "golive"
        ]
    );
    assert_eq!(c.steps[2].state, StepState::Done);
    assert_eq!(c.steps[4].state, StepState::Done);
    assert_eq!(
        c.steps[6].state,
        StepState::Todo,
        "nothing blocks 운영 시작"
    );
}

#[test]
fn regression_governance_20_the_rail_asks_for_a_second_passkey_until_there_are_two() {
    let one = SetupFacts {
        phase_is_setup: true,
        own_passkeys: 1,
        ..SetupFacts::default()
    };
    let c = checklist(&one);
    let step = c.steps.iter().find(|s| s.key == "passkey").unwrap();
    assert_eq!(
        (step.state, step.action, step.group),
        (StepState::Todo, "add_passkey", "operations")
    );
    // company-49: no step for the contact store that does not exist.
    assert!(!c.steps.iter().any(|s| s.key == "people"));
    let two = SetupFacts {
        own_passkeys: 2,
        ..one
    };
    let done = checklist(&two);
    assert_eq!(
        done.steps
            .iter()
            .find(|s| s.key == "passkey")
            .unwrap()
            .state,
        StepState::Done
    );
    assert_eq!(
        done.done,
        c.done + 1,
        "the second passkey counts toward readiness"
    );
    // Asked in every phase: Home keeps it after 운영 시작 until two exist.
    let operating = checklist(&SetupFacts {
        phase_is_setup: false,
        ..one
    });
    assert!(
        operating
            .steps
            .iter()
            .any(|s| s.key == "passkey" && s.state == StepState::Todo)
    );
}

// regression (governance-07, worst-case-38): with no contact store the
// step was Attention, which counted as 완료.
#[test]
fn regression_governance_07_a_security_contact_that_cannot_be_recorded_is_never_counted_done() {
    let base = SetupFacts {
        phase_is_setup: true,
        entities: 1,
        registrations: 1,
        workplaces: 1,
        org_change_approvers: 1,
        ..SetupFacts::default()
    };
    let c = checklist(&base);
    assert!(c.steps.iter().all(|s| s.key != "people"), "{c:?}");
    assert!(
        c.steps
            .iter()
            .all(|s| s.remedy != Some("security_contact_store_pending"))
    );
    assert_eq!(c.total, c.steps.len());
    let finished = c
        .steps
        .iter()
        .filter(|s| matches!(s.state, StepState::Done | StepState::Attention))
        .count();
    assert_eq!(c.done, finished);

    let store = SetupFacts {
        security_contact_store_available: true,
        ..base
    };
    let people = |f: &SetupFacts| {
        checklist(f)
            .steps
            .into_iter()
            .find(|s| s.key == "people")
            .map(|s| s.state)
    };
    assert_eq!(people(&store), Some(StepState::Todo));
    assert_eq!(
        people(&SetupFacts {
            security_contact_recorded: true,
            ..store
        }),
        Some(StepState::Done)
    );
}

#[test]
fn department_is_required_at_go_live_both_ways() {
    for org_step_skipped in [false, true] {
        let base = SetupFacts {
            phase_is_setup: true,
            terms_accepted: true,
            entities: 1,
            registrations: 1,
            workplaces: 1,
            access_admin_holders: 1,
            org_change_approvers: 1,
            employees_step_deferred: true,
            org_step_skipped,
            ..SetupFacts::default()
        };

        // When org_units == 0: org is required (not skippable), and blocks go-live
        let zero_org = checklist(&SetupFacts {
            org_units: 0,
            ..base
        });
        let org_step = zero_org.steps.iter().find(|s| s.key == "org").unwrap();
        assert!(!org_step.skippable, "부서 item is required, not skippable");
        assert_ne!(
            org_step.state,
            StepState::Done,
            "부서 is not done when 0 units"
        );
        let golive_step = zero_org.steps.iter().find(|s| s.key == "golive").unwrap();
        assert_eq!(
            golive_step.state,
            StepState::Blocked,
            "0 부서 blocks go-live"
        );
        assert_eq!(
            golive_step.remedy,
            Some("add_department"),
            "remedy directs to adding a department"
        );
        assert_eq!(golive_step.count, Some(1));

        // When org_units > 0: org is done, and does not block go-live
        let with_org = checklist(&SetupFacts {
            org_units: 2,
            ..base
        });
        let org_step_ok = with_org.steps.iter().find(|s| s.key == "org").unwrap();
        assert!(!org_step_ok.skippable, "부서 item is required");
        assert_eq!(org_step_ok.state, StepState::Done);
        assert_eq!(org_step_ok.count, Some(2));
        let golive_ok = with_org.steps.iter().find(|s| s.key == "golive").unwrap();
        assert_eq!(
            golive_ok.state,
            StepState::Todo,
            "positive 부서 allows go-live preview"
        );
    }
}
#[test]
fn company_text_is_placement_work_not_a_separate_setup_step() {
    let f = SetupFacts {
        phase_is_setup: true,
        entities: 1,
        workplaces: 1,
        employees: 1,
        unmapped_assignments: 1,
        ..SetupFacts::default()
    };
    let c = checklist(&f);
    assert_eq!(
        c.steps
            .iter()
            .find(|s| s.key == "employees")
            .unwrap()
            .remedy,
        Some("place_people")
    );
    assert!(!c.steps.iter().any(|s| s.key == "company_names"));
}
