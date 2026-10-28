// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::*;
use console_platform_request_context::audit_context::access_log::{
    AccessRecord, record_person_access,
};

pub(crate) async fn record(
    state: &OrgChangeRestState,
    principal: &Principal,
    record: AccessRecord<'_>,
    users: &[Uuid],
) -> Result<(), RestError> {
    record_person_access(state.store.pool(), principal, record, users)
        .await
        .map_err(|_| {
            RestError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "unavailable",
                "org access record could not be recorded",
            )
        })
}

pub(crate) async fn detail(
    s: &OrgChangeRestState,
    p: &Principal,
    detail: &console_orgchange_domain::OrgChangeDetail,
) -> Result<(), RestError> {
    let users: Vec<_> = std::iter::once(detail.summary.drafted_by)
        .chain(
            detail
                .approval_steps
                .iter()
                .filter_map(|step| step.decided_by),
        )
        .chain(
            detail
                .settlement_items
                .iter()
                .filter_map(|item| item.done_by),
        )
        .chain(detail.events.iter().map(|event| event.actor))
        .collect();
    let employees: Vec<_> = detail
        .proposal
        .iter()
        .filter_map(|op| match op {
            OrgProposalOp::ReassignOrgUnit { employee_ids, .. } => employee_ids.as_deref(),
            _ => None,
        })
        .flatten()
        .copied()
        .collect();
    record(
        s,
        p,
        AccessRecord {
            action: "org_change.read",
            target_type: "org_change",
            target_id: detail.summary.id.to_string(),
            subject_ids: &employees,
            reader_subject: None,
            details: json!({}),
        },
        &users,
    )
    .await
}
