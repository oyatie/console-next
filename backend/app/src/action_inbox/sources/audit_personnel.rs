// SPDX-License-Identifier: LicenseRef-Proprietary
//! Personnel projections retain the directory's access-before-reveal contract.
use console_action_inbox_application::ActionInboxSourcePage;
use console_hr_adapter_postgres::{
    HrError,
    directory::access_log::{DirectoryAccess, access_event, actor_employee_id},
};
use console_kernel_core::KernelError;
use console_platform_authz::Principal;
use console_platform_db::with_audits;

pub(crate) async fn record(
    pool: &sqlx::PgPool,
    principal: &Principal,
    page: &ActionInboxSourcePage,
) -> Result<(), KernelError> {
    let ids: std::collections::BTreeSet<uuid::Uuid> = page
        .items
        .iter()
        .flat_map(|i| &i.links)
        .filter(|link| link.kind == "employee")
        .map(|link| uuid::Uuid::parse_str(&link.id))
        .collect::<Result<_, _>>()
        .map_err(|_| KernelError::internal("invalid personnel projection"))?;
    if ids.is_empty() {
        return Ok(());
    }
    let principal = principal.clone();
    with_audits::<_, _, HrError>(pool, principal.org_id, move |tx| {
        Box::pin(async move {
            let actor = actor_employee_id(tx, &principal).await?;
            let event = access_event(
                &principal,
                DirectoryAccess::List,
                &ids.into_iter().collect::<Vec<_>>(),
                actor,
                serde_json::json!({"view":"action_inbox"}),
            )?;
            Ok(((), vec![event]))
        })
    })
    .await
    .map_err(|e| {
        tracing::error!(error = ?e, "inbox personnel access audit failed");
        KernelError::internal("failed to record personnel access")
    })
}
