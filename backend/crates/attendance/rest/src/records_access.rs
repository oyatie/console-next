// SPDX-License-Identifier: LicenseRef-Proprietary
//! The board's set, filter and count decisions use one Cedar snapshot.
use console_attendance_adapter_postgres::{BoardReadAccess, BoardReadTarget, ScheduleStoreError};
use console_attendance_domain::schedule::Level;
use console_kernel_core::OrgId;
use console_platform_authz::Feature;
use console_platform_authz::access::{NodeKind, NodeRef};
use console_platform_authz::cedar_pbac::visible::{DecisionFacts, EmployeePlacement};

pub(super) fn unavailable(_: impl std::fmt::Display) -> ScheduleStoreError {
    ScheduleStoreError::Corrupt("attendance read access")
}

pub(super) fn board_access(
    facts: DecisionFacts,
    org: OrgId,
) -> Result<BoardReadAccess, ScheduleStoreError> {
    let action = Feature::EmployeeDirectoryRead.as_str();
    let mut admitted = false;
    for kind in [
        NodeKind::Tenant,
        NodeKind::LegalEntity,
        NodeKind::Workplace,
        NodeKind::Department,
    ] {
        admitted |= !facts
            .visible(action, kind, "id", 1)
            .map_err(unavailable)?
            .is_deny_all();
    }
    if !admitted {
        return Err(ScheduleStoreError::Forbidden);
    }
    Ok(Box::new(move |target| {
        let node = match target {
            BoardReadTarget::Scope(level, id) => NodeRef {
                kind: match level {
                    Level::Workplace => NodeKind::Workplace,
                    Level::Department => NodeKind::Department,
                    _ => return Err(ScheduleStoreError::Forbidden),
                },
                id,
            },
            BoardReadTarget::Person {
                unit,
                workplace,
                entity,
            } => EmployeePlacement {
                org_unit_id: unit,
                workplace_id: workplace,
                legal_entity_id: entity,
            }
            .node(org, &facts),
        };
        facts.authorize(action, node).map_err(unavailable)
    }))
}
