// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_kernel_core::TenantPhase::{Operating, Setup};

#[test]
fn empty_setup_only_readies_modules_without_prerequisites() {
    let modules = readiness(&SetupFacts::default(), Setup);
    assert_eq!(
        modules
            .iter()
            .filter(|m| m.ready)
            .map(|m| m.key)
            .collect::<Vec<_>>(),
        ["home", "org", "access"]
    );
    assert_eq!(
        modules.iter().find(|m| m.key == "people").unwrap().unblock,
        Some("create_legal_entity")
    );
}

#[test]
fn people_need_both_an_entity_and_a_workplace() {
    for (entities, workplaces, remedy) in [
        (0, 1, Some("create_legal_entity")),
        (1, 0, Some("create_workplace")),
        (1, 1, None),
    ] {
        let modules = readiness(
            &SetupFacts {
                entities,
                workplaces,
                ..SetupFacts::default()
            },
            Setup,
        );
        let people = modules.iter().find(|m| m.key == "people").unwrap();
        assert_eq!(people.ready, remedy.is_none());
        assert_eq!(people.unblock, remedy);
    }
}

#[test]
fn operating_modules_need_operations_and_current_employees() {
    for (phase, employees, remedy) in [
        (Setup, 1, Some("open_go_live_preview")),
        (Operating, 0, Some("register_employee")),
        (Operating, 1, None),
    ] {
        let modules = readiness(
            &SetupFacts {
                entities: 1,
                workplaces: 1,
                employees,
                employees_starting_later: 1,
                ..SetupFacts::default()
            },
            phase,
        );
        for key in ["exits", "attendance", "statutory"] {
            let module = modules.iter().find(|m| m.key == key).unwrap();
            assert_eq!(module.ready, remedy.is_none(), "{key}");
            assert_eq!(module.unblock, remedy, "{key}");
        }
    }
}
