// SPDX-License-Identifier: LicenseRef-Proprietary
//! Tenant readiness only; destination permissions remain the destination's decision.
use console_kernel_core::TenantPhase;
use serde::Serialize;

use crate::SetupFacts;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Module {
    pub key: &'static str,
    pub ready: bool,
    pub unblock: Option<&'static str>,
}

#[derive(Debug, Clone, Copy)]
pub struct ModulePrerequisites {
    pub has_entity: bool,
    pub has_workplace: bool,
    pub has_employee: bool,
}

impl From<&SetupFacts> for ModulePrerequisites {
    fn from(f: &SetupFacts) -> Self {
        Self {
            has_entity: f.entities > 0,
            has_workplace: f.workplaces > 0,
            has_employee: f.employees > 0,
        }
    }
}

#[must_use]
pub fn readiness(facts: impl Into<ModulePrerequisites>, phase: TenantPhase) -> Vec<Module> {
    let f = facts.into();
    let people = if !f.has_entity {
        Some("create_legal_entity")
    } else if !f.has_workplace {
        Some("create_workplace")
    } else {
        None
    };
    let operating = if phase != TenantPhase::Operating {
        Some("open_go_live_preview")
    } else if !f.has_employee {
        Some("register_employee")
    } else {
        None
    };
    [
        ("home", None),
        ("org", None),
        ("access", None),
        ("people", people),
        ("exits", operating),
        ("attendance", operating),
        ("statutory", operating),
    ]
    .into_iter()
    .map(|(key, unblock)| Module {
        key,
        ready: unblock.is_none(),
        unblock,
    })
    .collect()
}
