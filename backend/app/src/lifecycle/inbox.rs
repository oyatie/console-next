// SPDX-License-Identifier: LicenseRef-Proprietary
//! The queue uses the lock record's exact second-person decision.
use super::{LifecycleError, period_unlock::SETTING_KEYS, unlock_decision::decider_stands};
use console_action_inbox_application::{
    ActionInboxLink, ActionInboxSourceItem, ActionInboxSourcePage, ActionInboxSourceQuery,
};
use console_kernel_core::KernelError;
use console_platform_authz::Principal;
use console_platform_db::{period_lock::UnlockRequest, with_org_conn};
use console_settings_adapter_postgres::resolve_in_tx;
use time::OffsetDateTime;
use uuid::Uuid;

pub(crate) async fn page(
    pool: &sqlx::PgPool,
    principal: &Principal,
    query: ActionInboxSourceQuery,
) -> Result<ActionInboxSourcePage, KernelError> {
    let principal = principal.clone();
    let org = principal.org_id;
    with_org_conn::<_, _, LifecycleError>(pool, org, move |tx| Box::pin(async move {
        let facts = console_platform_authz::cedar_pbac::visible::load_facts(tx, org, *principal.user_id.as_uuid()).await?;
        use console_platform_authz::access::{NodeKind, NodeRef};
        if !facts.authorize(console_platform_authz::Feature::PeriodLockManage.as_str(), NodeRef { kind: NodeKind::Tenant, id: *org.as_uuid() })
            .map_err(|e| console_kernel_core::KernelError::internal(e.to_string()))? {
            return Ok(crate::action_inbox::empty_source_page());
        }
        type Row = (Uuid, Uuid, Uuid, String, Option<String>, OffsetDateTime, Uuid, OffsetDateTime, String, time::Date, time::Date, String, Option<serde_json::Value>);
        let rows: Vec<Row> = sqlx::query_as("SELECT r.id, r.lock_id, r.requested_by, r.reason_code, r.reason_note, r.relock_at, r.step_up_assertion_id, r.requested_at, l.domain, l.period_start, l.period_end, (SELECT u.display_name FROM person_accounts_current u WHERE u.org_id = r.org_id AND u.id = r.requested_by), (SELECT jsonb_build_object('system', false, 'label_ko', c.label_ko, 'label_en', c.label_en) FROM reason_codes c WHERE c.org_id = r.org_id AND c.domain = 'period_unlock' AND c.code = r.reason_code) FROM period_unlock_requests r JOIN period_locks l ON l.org_id = r.org_id AND l.id = r.lock_id WHERE r.org_id = $1 AND r.outcome IS NULL AND r.relock_at > $2 AND r.requested_at <= $3 AND period_lock_effective(l) ORDER BY r.requested_at, r.id")
            .bind(org.as_uuid()).bind(query.now).bind(query.as_of).fetch_all(tx.as_mut()).await?;
        let settings = resolve_in_tx(tx.as_mut(), org, &SETTING_KEYS, None, query.now).await?;
        let mut items = Vec::new();
        for (id, lock_id, requested_by, reason_code, reason_note, relock_at, step_up_assertion_id, requested_at, domain, start, end, requester, reason_entry) in rows {
            let request = UnlockRequest { id, lock_id, requested_by, reason_code, reason_note, relock_at, step_up_assertion_id, requested_at };
            match decider_stands(tx, &principal, &request, &settings).await {
                Ok(_) => {},
                Err(e) if e.status == http::StatusCode::FORBIDDEN => continue,
                Err(e) => return Err(e),
            }
            items.push(ActionInboxSourceItem {
                context: Some(serde_json::json!({"unlock": {
                    "domain": domain, "periodStart": start.to_string(), "periodEnd": end.to_string(),
                    "requester": requester, "reason_code": request.reason_code, "reason_entry": reason_entry
                }, "reason": request.reason_note.unwrap_or_default()})),
                id: format!("period_unlock:{id}"), kind: "period_unlock".into(), ref_code: String::new(),
                title: requester, site: None, who: None, due: Some(relock_at), submitted: Some(requested_at), created_at: requested_at,
                links: vec![ActionInboxLink { kind: "period_lock".into(), id: lock_id.to_string(), label: None }],
            });
        }
        items.extend(super::unlock_review::items(tx, &principal, query.as_of).await?);
        let total = items.len();
        let (items, has_more) = console_action_inbox_application::page_source_items(items, &query);
        Ok(ActionInboxSourcePage { items, total, total_is_exact: true, has_more })
    })).await.map_err(|e| { tracing::error!(error = ?e, "unlock inbox source failed"); KernelError::internal("failed to load unlock work") })
}
