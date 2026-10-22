// SPDX-License-Identifier: LicenseRef-Proprietary
//! Personal queue presentation metadata comes from the same principal and traversal.
use super::*;
use console_action_inbox_application::ActionInboxPage;

pub(super) fn project(
    sources: &PgActionInboxSources,
    page: ActionInboxPage,
    filter: InboxFilter,
    first: bool,
    now: OffsetDateTime,
) -> Result<Json<serde_json::Value>, InboxError> {
    let unavailable: Vec<_> = page.unavailable.iter().map(|source| serde_json::json!({ "source": source, "support_reference": sources.support_reference })).collect();
    let mut response = serde_json::to_value(page).map_err(|e| source_failure("projection", e))?;
    response["unavailable"] = serde_json::json!(unavailable);
    use console_platform_authz::Feature as F;
    let can = |feature| sources::org_change::holds(&sources.principal, feature);
    response["has_work"] = serde_json::json!(
        [
            F::OrgChangeRead,
            F::OrgChangeDraft,
            F::OrgChangeApprove,
            F::OrgChangeApply,
            F::EmployeeDirectoryRead,
            F::EmployeeDirectoryManage,
            F::UserManage,
            F::PeriodLockManage,
            F::ExitCaseHrConfirm,
            F::ExitCaseHqConfirm,
            F::ExitSettlementManage,
            F::ExcelDownload,
            F::JobTitleManage
        ]
        .into_iter()
        .any(can)
    );
    let org_work = can(F::OrgChangeRead);
    let people_work = [
        F::EmployeeDirectoryRead,
        F::EmployeeDirectoryManage,
        F::PeriodLockManage,
        F::ExitCaseHrConfirm,
        F::ExitCaseHqConfirm,
        F::ExitSettlementManage,
    ]
    .into_iter()
    .any(can);
    response["available_filters"] = serde_json::json!(
        [
            ("turn", org_work || people_work),
            ("waiting", org_work),
            ("scheduled", org_work),
            ("deadlines", org_work || people_work),
            (
                "failures",
                console_platform_authz::authorize_org_wide(
                    &sources.principal,
                    console_platform_authz::Action::new(F::EmployeeDirectoryManage)
                )
                .is_ok()
            )
        ]
        .into_iter()
        .filter(|(_, enabled)| *enabled)
        .map(|(key, _)| key)
        .collect::<Vec<_>>()
    );
    response["quick_starts"] = serde_json::json!(
        [
            ("register", F::EmployeeDirectoryManage),
            ("import", F::EmployeeDirectoryManage),
            ("org", F::OrgChangeDraft),
            ("invite", F::UserManage)
        ]
        .into_iter()
        .filter(|(_, feature)| can(*feature))
        .map(|(key, _)| key)
        .collect::<Vec<_>>()
    );
    response["as_of"] = serde_json::json!(
        now.format(&time::format_description::well_known::Rfc3339)
            .map_err(|e| source_failure("clock", e))?
    );
    if matches!(filter, InboxFilter::All | InboxFilter::Turn)
        && first
        && let Some(Some(setup)) = sources.setup.get()
    {
        response["setup"] = setup.clone();
    }
    Ok(Json(response))
}
