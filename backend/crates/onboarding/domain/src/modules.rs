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

#[must_use]
pub fn readiness(f: &SetupFacts, phase: TenantPhase) -> Vec<Module> {
    let people = if f.entities == 0 {
        Some("create_legal_entity")
    } else if f.workplaces == 0 {
        Some("create_workplace")
    } else {
        None
    };
    let operating = if phase != TenantPhase::Operating {
        Some("open_go_live_preview")
    } else if f.employees == 0 {
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
