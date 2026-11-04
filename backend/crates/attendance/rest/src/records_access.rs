// SPDX-License-Identifier: LicenseRef-Proprietary
//! Attendance read set, filter and count decisions use one Cedar snapshot.
use console_attendance_adapter_postgres::{BoardReadAccess, BoardReadTarget, ScheduleStoreError};
use console_attendance_domain::schedule::Level;
use console_kernel_core::OrgId;
use console_platform_authz::Feature;
use console_platform_authz::access::{NodeKind, NodeRef};
use console_platform_authz::cedar_pbac::visible::DecisionFacts;

pub(super) fn unavailable(_: impl std::fmt::Display) -> ScheduleStoreError {
    ScheduleStoreError::Corrupt("attendance read access")
}

pub(super) fn read_access(
    facts: DecisionFacts,
    org: OrgId,
) -> Result<BoardReadAccess, ScheduleStoreError> {
    let action = Feature::EmployeeDirectoryRead.as_str();
    let mut admitted = false;
    for kind in [NodeKind::Tenant, NodeKind::Workplace] {
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
            BoardReadTarget::Person { workplace } => NodeRef {
                // Keep the board's workplace boundary until all attendance surfaces move together.
                kind: if workplace.is_some() {
                    NodeKind::Workplace
                } else {
                    NodeKind::Tenant
                },
                id: workplace.unwrap_or(*org.as_uuid()),
            },
        };
        facts.authorize(action, node).map_err(unavailable)
    }))
}

macro_rules! load {
    ($org:expr, $actor:expr) => {{
        let (org, actor) = ($org, $actor);
        move |tx| {
            Box::pin(async move {
                let facts = console_platform_authz::cedar_pbac::visible::load_facts(tx, org, actor)
                    .await
                    .map_err($crate::records::access::unavailable)?;
                $crate::records::access::read_access(facts, org)
            })
        }
    }};
}
pub(super) use load;
