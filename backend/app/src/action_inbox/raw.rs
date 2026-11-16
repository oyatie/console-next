// SPDX-License-Identifier: LicenseRef-Proprietary
//! The sources as they are, before the request's snoozes and the access log.
use super::*;

pub(super) struct Raw<'a>(pub(super) &'a PgActionInboxSources);

impl ActionInboxSourcePort for Raw<'_> {
    fn deadline_due_soon_days(&self) -> Result<i64, KernelError> {
        Ok(self.0.deadline_due_soon_days)
    }

    fn list_source_page(
        &self,
        source: ActionInboxSource,
        query: ActionInboxSourceQuery,
    ) -> ActionInboxSourceFuture<'_> {
        let sources = self.0;
        Box::pin(async move {
            match source {
                #[cfg(feature = "workspace")]
                ActionInboxSource::Workflow => sources.workflow_page(query).await,
                #[cfg(feature = "dispatch")]
                ActionInboxSource::Dispatch => sources.dispatch_page(query).await,
                #[cfg(feature = "support")]
                ActionInboxSource::Support => sources.support_page(query).await,
                #[cfg(feature = "workorder")]
                ActionInboxSource::WorkOrder => sources.work_order_page(query).await,
                #[cfg(feature = "payroll")]
                ActionInboxSource::Payroll => sources.payroll_page(query).await,
                #[cfg(feature = "governance")]
                ActionInboxSource::Governance => sources.governance_page(query).await,
                ActionInboxSource::HrIdentity
                | ActionInboxSource::HrUnplaced
                | ActionInboxSource::HrContract => {
                    sources::hr_followups::page(&sources.pool, &sources.principal, source, query)
                        .await
                }
                ActionInboxSource::PeriodUnlock => {
                    crate::lifecycle::inbox::page(&sources.pool, &sources.principal, query).await
                }
                ActionInboxSource::Setup => {
                    let setup = sources
                        .setup
                        .get_or_try_init(|| {
                            sources::setup::load(
                                &sources.pool,
                                &sources.principal,
                                &sources.authorization,
                            )
                        })
                        .await;
                    setup.map(|setup| {
                        sources::setup::page(
                            setup.as_ref(),
                            *sources.principal.org_id.as_uuid(),
                            sources.setup_created_at,
                            query,
                        )
                    })
                }
                ActionInboxSource::GrantNotice => {
                    sources::grants::page(&sources.pool, &sources.principal, query).await
                }
                ActionInboxSource::SupportAccess => {
                    sources::support_access::page(
                        &sources.pool,
                        &sources.principal,
                        query,
                        &sources.support_can_approve,
                        &sources.authorization,
                    )
                    .await
                }
                ActionInboxSource::PrivacyRequests => {
                    sources::privacy_requests::page(
                        &sources.pool,
                        &sources.principal,
                        query,
                        &sources.privacy_can_handle,
                        &sources.authorization,
                    )
                    .await
                }
                ActionInboxSource::EntityCorrections => {
                    sources::entity_corrections::page(&sources.pool, &sources.principal, query)
                        .await
                }
                ActionInboxSource::RegistrationChecks => {
                    sources::registration_checks::page(&sources.pool, &sources.principal, query)
                        .await
                }
                ActionInboxSource::OrgChange => {
                    sources::org_change::page(
                        &sources.pool,
                        &sources.principal,
                        query,
                        sources
                            .policies
                            .get(&console_settings_domain::SettingKey::ApprovalPolicyOrgStructure)
                            .copied()
                            .flatten(),
                        &sources.authorization,
                    )
                    .await
                }
                ActionInboxSource::HrExit => {
                    sources::hr_exit::page(
                        &sources.pool,
                        &sources.principal,
                        query,
                        &sources.statutory_register,
                        &sources.authorization,
                    )
                    .await
                }
                ActionInboxSource::HrLifecycle => {
                    sources::hr_lifecycle::page(&sources.pool, &sources.principal, query).await
                }
                ActionInboxSource::HrRegister => {
                    sources::hr_register::page(&sources.pool, &sources.principal, query).await
                }
                ActionInboxSource::HrRequests => {
                    sources::hr_requests::page(
                        &sources.pool,
                        &sources.principal,
                        query,
                        &sources.policies,
                    )
                    .await
                }
                ActionInboxSource::HrInsurance => {
                    sources::hr_insurance::page(
                        &sources.pool,
                        &sources.principal,
                        query,
                        &sources.statutory_register,
                        sources.log_access,
                    )
                    .await
                }
                #[allow(unreachable_patterns)]
                _ => Ok(empty_source_page()),
            }
        })
    }
}
