// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_action_inbox_application::{ActionInboxLink, ActionInboxSourceItem};
#[cfg(feature = "dispatch")]
use console_dispatch_adapter_postgres::PgDispatchStore;
#[cfg(feature = "governance")]
use console_governance_adapter_postgres::PgGovernanceStore;
#[cfg(feature = "payroll")]
use console_payroll_adapter_postgres::PgPayrollStore;
#[cfg(any(feature = "payroll", feature = "governance"))]
use console_platform_authz::{Action, Feature, authorize_org_wide};
#[cfg(feature = "support")]
use console_support_adapter_postgres::PgSupportStore;
#[cfg(feature = "workorder")]
use console_workorder_adapter_postgres::PgWorkOrderStore;
#[cfg(feature = "workorder")]
use console_workorder_application::{
    ActionInboxPosition as WorkOrderActionInboxPosition, ActionInboxWorkOrderPort,
};
impl PgActionInboxSources {
    #[cfg(feature = "dispatch")]
    pub(super) async fn dispatch_page(
        &self,
        query: ActionInboxSourceQuery,
    ) -> Result<ActionInboxSourcePage, KernelError> {
        let after = query
            .after
            .map(|position| (position.created_at, position.id));
        let source_limit = i64::try_from(query.limit).unwrap_or(200);
        let (offers, total, has_more) = PgDispatchStore::new(self.pool.clone())
            .list_my_pending_offers_action_page(
                self.principal.user_id,
                &self.principal.branch_scope,
                query.now,
                query.as_of,
                after,
                source_limit,
            )
            .await
            .map_err(|error| source_failure("dispatch", error))?;
        let items = offers
            .into_iter()
            .map(|offer| ActionInboxSourceItem {
                context: None,
                id: format!("dispatch:{}", offer.dispatch_id),
                kind: "dispatch".to_owned(),
                ref_code: offer.request_no.clone(),
                title: offer.request_no,
                site: None,
                who: Some("미배정".to_owned()),
                due: Some(offer.accept_window_ends_at),
                submitted: Some(offer.accept_window_started_at),
                links: vec![ActionInboxLink {
                    kind: "work_order".to_owned(),
                    id: offer.work_order_id.to_string(),
                    label: None,
                }],
                created_at: offer.created_at,
            })
            .collect();
        Ok(ActionInboxSourcePage {
            items,
            total: usize::try_from(total).unwrap_or(0),
            total_is_exact: true,
            has_more,
        })
    }

    #[cfg(feature = "support")]
    pub(super) async fn support_page(
        &self,
        query: ActionInboxSourceQuery,
    ) -> Result<ActionInboxSourcePage, KernelError> {
        let after = query
            .after
            .map(|position| (position.created_at, position.id));
        let source_limit = i64::try_from(query.limit).unwrap_or(200);
        let (tickets, total, has_more) = PgSupportStore::new(self.pool.clone())
            .list_assigned_action_inbox_page(
                self.principal.branch_scope.clone(),
                self.principal.user_id,
                query.as_of,
                after,
                source_limit,
            )
            .await
            .map_err(|error| source_failure("support", error))?;
        let items = tickets
            .into_iter()
            .map(|ticket| ActionInboxSourceItem {
                context: None,
                id: format!("support:{}", ticket.id),
                kind: "support".to_owned(),
                ref_code: ticket.id.to_string(),
                title: ticket.title,
                site: None,
                who: ticket.assignee_name,
                due: ticket.due_at,
                submitted: Some(ticket.created_at),
                links: vec![ActionInboxLink {
                    kind: "support_ticket".to_owned(),
                    id: ticket.id.to_string(),
                    label: None,
                }],
                created_at: ticket.created_at,
            })
            .collect();
        Ok(ActionInboxSourcePage {
            items,
            total: usize::try_from(total).unwrap_or(0),
            total_is_exact: true,
            has_more,
        })
    }

    #[cfg(feature = "workorder")]
    pub(super) async fn work_order_page(
        &self,
        query: ActionInboxSourceQuery,
    ) -> Result<ActionInboxSourcePage, KernelError> {
        let source_limit = i64::try_from(query.limit).unwrap_or(200);
        let page = PgWorkOrderStore::new(self.pool.clone())
            .list_assigned_action_inbox_page(
                self.principal.org_id,
                self.principal.branch_scope.clone(),
                self.principal.user_id,
                query.as_of,
                query.after.map(|position| WorkOrderActionInboxPosition {
                    created_at: position.created_at,
                    id: position.id,
                }),
                source_limit,
            )
            .await
            .map_err(|error| source_failure("workorder", error))?;
        let items = page
            .items
            .into_iter()
            .map(|row| ActionInboxSourceItem {
                context: None,
                id: format!("work:{}", row.id),
                kind: "work".to_owned(),
                ref_code: row.request_no.clone(),
                title: row.request_no,
                site: Some(row.site_name),
                who: None,
                due: row.target_due_at,
                submitted: Some(row.created_at),
                links: vec![ActionInboxLink {
                    kind: "work_order".to_owned(),
                    id: row.id.to_string(),
                    label: None,
                }],
                created_at: row.created_at,
            })
            .collect();
        Ok(ActionInboxSourcePage {
            items,
            total: usize::try_from(page.total).unwrap_or(0),
            total_is_exact: true,
            has_more: page.has_more,
        })
    }

    #[cfg(feature = "payroll")]
    pub(super) async fn payroll_page(
        &self,
        query: ActionInboxSourceQuery,
    ) -> Result<ActionInboxSourcePage, KernelError> {
        // Inbox is a merged read: callers without org-wide PayrollRunManage
        // (built-in EXECUTIVE/SUPER_ADMIN) get an empty source, not 403.
        if authorize_org_wide(&self.principal, Action::new(Feature::PayrollRunManage)).is_err() {
            return Ok(empty_source_page());
        }
        let after = query
            .after
            .map(|position| (position.created_at, position.id));
        let source_limit = i64::try_from(query.limit).unwrap_or(200);
        let (runs, total, has_more) = PgPayrollStore::new(self.pool.clone())
            .list_submitted_action_inbox_page(
                self.principal.user_id,
                query.as_of,
                after,
                source_limit,
            )
            .await
            .map_err(|error| source_failure("payroll", error))?;
        let items = runs
            .into_iter()
            .map(|run| ActionInboxSourceItem {
                context: None,
                id: format!("payroll:{}", run.id),
                kind: "payroll".to_owned(),
                ref_code: run.source_label.clone(),
                title: run.source_label,
                site: None,
                who: None,
                due: None,
                submitted: Some(run.submitted_at),
                links: vec![ActionInboxLink {
                    kind: "pay_run".to_owned(),
                    id: run.id.to_string(),
                    label: None,
                }],
                created_at: run.submitted_at,
            })
            .collect();
        Ok(ActionInboxSourcePage {
            items,
            total: usize::try_from(total).unwrap_or(0),
            total_is_exact: true,
            has_more,
        })
    }

    #[cfg(feature = "governance")]
    pub(super) async fn governance_page(
        &self,
        query: ActionInboxSourceQuery,
    ) -> Result<ActionInboxSourcePage, KernelError> {
        // Match the decide REST gate so pending four-eyes do not leak to
        // callers who cannot act.
        if authorize_org_wide(&self.principal, Action::new(Feature::RoleManage)).is_err() {
            return Ok(empty_source_page());
        }
        let after = query
            .after
            .map(|position| (position.created_at, position.id));
        let source_limit = i64::try_from(query.limit).unwrap_or(200);
        let (requests, total, has_more) = PgGovernanceStore::new(self.pool.clone())
            .list_pending_action_inbox_page(
                self.principal.user_id,
                query.as_of,
                after,
                source_limit,
            )
            .await
            .map_err(|error| source_failure("governance", error))?;
        let items = requests
            .into_iter()
            .map(|request| ActionInboxSourceItem {
                context: None,
                id: format!("governance:{}", request.id),
                kind: "governance".to_owned(),
                ref_code: request.request_ref.to_string(),
                title: request.kind,
                site: None,
                who: None,
                due: None,
                submitted: Some(request.created_at),
                links: vec![ActionInboxLink {
                    kind: "approval_request".to_owned(),
                    id: request.request_ref.to_string(),
                    label: None,
                }],
                created_at: request.created_at,
            })
            .collect();
        Ok(ActionInboxSourcePage {
            items,
            total: usize::try_from(total).unwrap_or(0),
            total_is_exact: true,
            has_more,
        })
    }
}
