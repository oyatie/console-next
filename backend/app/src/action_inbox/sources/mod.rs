pub(super) mod hr_exit;
pub(super) mod hr_insurance;
pub(super) mod hr_lifecycle;
pub(super) mod hr_register;
pub(super) mod hr_requests;
pub(super) mod org_change;
pub(super) mod support_access;

use super::{
    ActionInboxSource, ActionInboxSourceFuture, ActionInboxSourcePort, ActionInboxSourceQuery,
    PgActionInboxSources,
};

impl ActionInboxSourcePort for PgActionInboxSources {
    fn list_source_page(
        &self,
        source: ActionInboxSource,
        query: ActionInboxSourceQuery,
    ) -> ActionInboxSourceFuture<'_> {
        Box::pin(async move {
            match source {
                ActionInboxSource::Workflow => self.workflow_page(query).await,
                ActionInboxSource::Dispatch => self.dispatch_page(query).await,
                ActionInboxSource::Support => self.support_page(query).await,
                ActionInboxSource::WorkOrder => self.work_order_page(query).await,
                ActionInboxSource::Payroll => self.payroll_page(query).await,
                ActionInboxSource::Governance => self.governance_page(query).await,
                ActionInboxSource::OrgChange => {
                    org_change::page(&self.pool, &self.principal, query).await
                }
                ActionInboxSource::HrExit => {
                    hr_exit::page(&self.pool, &self.principal, query).await
                }
                ActionInboxSource::HrLifecycle => {
                    hr_lifecycle::page(&self.pool, &self.principal, query).await
                }
                ActionInboxSource::HrRegister => {
                    hr_register::page(&self.pool, &self.principal, query).await
                }
                ActionInboxSource::HrRequests => {
                    hr_requests::page(&self.pool, &self.principal, query).await
                }
                ActionInboxSource::HrInsurance => {
                    hr_insurance::page(&self.pool, &self.principal, query).await
                }
                ActionInboxSource::SupportAccess => {
                    support_access::page(&self.pool, &self.principal, query).await
                }
            }
        })
    }
}
