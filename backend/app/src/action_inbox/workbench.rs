// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use crate::workbench::{
    ActionInboxItem as WorkbenchActionInboxItem, ActionInboxPage as WorkbenchActionInboxPage,
    SourceFailure as WorkbenchSourceFailure, WorkbenchSourceRef, WorkbenchTarget, WorkbenchUrgency,
};
use console_action_inbox_application::{
    ActionInboxItem as ApplicationActionInboxItem, CompleteActionInboxError,
    canonical_action_link_kind, list_complete_action_inbox,
};
use console_kernel_core::ErrorKind;
/// Reuses the native action-inbox application boundary for the aggregate
/// workbench. The workbench must not query source tables or reproduce source
/// authorization; it only narrows the already-authorized projection into its
/// frozen response contract.
pub(crate) async fn read_workbench_action_inbox(
    pool: &PgPool,
    principal: &Principal,
    as_of: OffsetDateTime,
    _limit: usize,
    read_permits: std::sync::Arc<tokio::sync::Semaphore>,
) -> Result<WorkbenchActionInboxPage, WorkbenchSourceFailure> {
    let sources = PgActionInboxSources {
        pool: pool.clone(),
        principal: principal.clone(),
        setup: tokio::sync::OnceCell::new(),
        setup_created_at: as_of,
        read_permits,
        support_reference: crate::telemetry::current_trace_context()
            .trace_id()
            .to_owned(),
    };
    let page = list_complete_action_inbox(&sources, as_of)
        .await
        .map_err(workbench_complete_source_error)?;
    let items = page
        .items
        .into_iter()
        .map(project_workbench_action)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(WorkbenchActionInboxPage {
        as_of,
        total: page.total,
        items,
    })
}

fn project_workbench_action(
    item: ApplicationActionInboxItem,
) -> Result<WorkbenchActionInboxItem, WorkbenchSourceFailure> {
    let source_id = item
        .id
        .rsplit_once(':')
        .and_then(|(_, value)| uuid::Uuid::parse_str(value).ok())
        .ok_or(WorkbenchSourceFailure::Unavailable {
            code: "action_inbox_unavailable",
        })?;
    let urgency = match item.urg {
        "now" => WorkbenchUrgency::Now,
        "today" => WorkbenchUrgency::Today,
        "wait" => WorkbenchUrgency::Wait,
        _ => {
            return Err(WorkbenchSourceFailure::Unavailable {
                code: "action_inbox_unavailable",
            });
        }
    };
    let (target_module, target_id) = item
        .links
        .first()
        .filter(|link| !link.kind.trim().is_empty() && !link.id.trim().is_empty())
        .map(|link| {
            (
                canonical_action_link_kind(&link.kind).to_owned(),
                link.id.clone(),
            )
        })
        .ok_or(WorkbenchSourceFailure::Unavailable {
            code: "action_inbox_unavailable",
        })?;
    if item.kind.trim().is_empty() || item.title.trim().is_empty() {
        return Err(WorkbenchSourceFailure::Unavailable {
            code: "action_inbox_unavailable",
        });
    }
    Ok(WorkbenchActionInboxItem {
        id: item.id,
        urgency,
        title: item.title,
        due_at: item.due,
        source: WorkbenchSourceRef {
            kind: item.kind,
            id: source_id,
        },
        target: WorkbenchTarget {
            module: target_module,
            id: target_id,
        },
    })
}

fn workbench_complete_source_error(error: CompleteActionInboxError) -> WorkbenchSourceFailure {
    match error {
        CompleteActionInboxError::Source(error) => workbench_source_error(error),
        CompleteActionInboxError::TotalInexact => WorkbenchSourceFailure::Unavailable {
            code: "action_inbox_total_inexact",
        },
        CompleteActionInboxError::BudgetExceeded => WorkbenchSourceFailure::Unavailable {
            code: "action_inbox_scan_budget_exceeded",
        },
        CompleteActionInboxError::TotalDrift => WorkbenchSourceFailure::Unavailable {
            code: "action_inbox_membership_changed",
        },
        CompleteActionInboxError::RepeatedCursor | CompleteActionInboxError::DuplicateId => {
            WorkbenchSourceFailure::Unavailable {
                code: "action_inbox_unavailable",
            }
        }
    }
}

fn workbench_source_error(error: KernelError) -> WorkbenchSourceFailure {
    if error.kind == ErrorKind::Forbidden {
        WorkbenchSourceFailure::Denied {
            code: "action_inbox_access_denied",
        }
    } else {
        WorkbenchSourceFailure::Unavailable {
            code: "action_inbox_unavailable",
        }
    }
}
