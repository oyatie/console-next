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
use std::collections::{BTreeSet, HashMap};
use uuid::Uuid;

pub(crate) async fn record(
    pool: &sqlx::PgPool,
    principal: &Principal,
    page: &mut ActionInboxSourcePage,
) -> Result<(), KernelError> {
    let ids: BTreeSet<Uuid> = page
        .items
        .iter()
        .flat_map(|i| &i.links)
        .filter(|link| link.kind == "employee")
        .map(|link| Uuid::parse_str(&link.id))
        .collect::<Result<_, _>>()
        .map_err(|_| KernelError::internal("invalid personnel projection"))?;
    if ids.is_empty() {
        return Ok(());
    }
    let case_ids: Vec<_> = page
        .items
        .iter()
        .flat_map(|i| &i.links)
        .filter(|link| link.kind == "exit_case")
        .map(|link| link.id.clone())
        .collect();
    let (access, details) = if case_ids.is_empty() {
        (
            DirectoryAccess::List,
            serde_json::json!({"view":"action_inbox"}),
        )
    } else {
        (
            DirectoryAccess::ExitCaseList,
            serde_json::json!({"view":"action_inbox", "case_ids":case_ids}),
        )
    };
    let ids: Vec<_> = ids.into_iter().collect();
    let principal = principal.clone();
    let places: Vec<(Uuid, Option<String>, Option<String>)> = with_audits::<_, _, HrError>(pool, principal.org_id, move |tx| {
        Box::pin(async move {
            let places = sqlx::query_as(concat!(
                "SELECT e.id, CASE WHEN ea.workplace_id IS NOT NULL THEN NULLIF(concat_ws(' › ', le.name, wp.name, \
                   CASE WHEN lower(unit.attributes->>'kind') NOT IN ('company','site') \
                     THEN NULLIF(unit.attributes->>'name','') END), '') END AS site, \
                 NULLIF(btrim(e.worksite_name),'') FROM person_employees_current e ",
                console_hr_adapter_postgres::assignment_lateral!(),
                " LEFT JOIN LATERAL (SELECT r.name FROM legal_entity_revisions r \
                    WHERE r.org_id=e.org_id AND r.legal_entity_id=ea.legal_entity_id \
                      AND r.effective_from<=entity_today() ORDER BY r.effective_from DESC,r.version DESC LIMIT 1) le ON TRUE \
                  LEFT JOIN LATERAL (SELECT r.name FROM workplace_revisions r \
                    WHERE r.org_id=e.org_id AND r.workplace_id=ea.workplace_id \
                      AND r.effective_from<=entity_today() ORDER BY r.effective_from DESC,r.version DESC LIMIT 1) wp ON TRUE \
                  LEFT JOIN LATERAL (SELECT r.attributes FROM org_unit_revisions r \
                    WHERE r.org_id=e.org_id AND r.org_unit_id=e.org_unit_id \
                      AND (r.attributes->>'effective_from' IS NULL \
                        OR entity_try_iso_date(r.attributes->>'effective_from')<=entity_today()) \
                    ORDER BY r.version DESC LIMIT 1) unit ON TRUE \
                  WHERE e.org_id=$1 AND e.id=ANY($2)"
            )).bind(principal.org_id.as_uuid()).bind(&ids).fetch_all(tx.as_mut()).await?;
            let actor = actor_employee_id(tx, &principal).await?;
            let event = access_event(
                &principal,
                access,
                &ids,
                actor,
                details,
            )?;
            Ok((places, vec![event]))
        })
    })
    .await
    .map_err(|e| {
        tracing::error!(error = ?e, "inbox personnel access audit failed");
        KernelError::internal("failed to record personnel access")
    })?;
    let places: HashMap<_, _> = places
        .into_iter()
        .map(|(id, site, worksite)| (id, (site, worksite)))
        .collect();
    for item in &mut page.items {
        let place = item
            .links
            .iter()
            .find(|link| link.kind == "employee")
            .and_then(|link| Uuid::parse_str(&link.id).ok())
            .and_then(|id| places.get(&id));
        if let Some((site, worksite)) = place {
            item.site.clone_from(site);
            if let Some(worksite) = worksite {
                let context = item.context.get_or_insert_with(|| serde_json::json!({}));
                let context = context
                    .as_object_mut()
                    .ok_or_else(|| KernelError::internal("invalid personnel context"))?;
                context.insert("worksite_name".into(), serde_json::json!(worksite));
            }
        }
    }
    Ok(())
}
