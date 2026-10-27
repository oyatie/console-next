// SPDX-License-Identifier: LicenseRef-Proprietary
//! Org-change work uses the same feature floors, policy and person SoD as its record.

use crate::error::AppError;
use console_action_inbox_application::{
    ActionInboxLink, ActionInboxSourceItem, ActionInboxSourcePage, ActionInboxSourceQuery,
};
use console_kernel_core::KernelError;
use console_platform_authz::{
    Action, Feature, PermissionLevel, Principal, authorize_capability, permission_for,
};
use console_platform_db::with_org_conn;
use console_settings_adapter_postgres::approval_routes_in_tx;
use console_settings_domain::SettingKey;
use sqlx::PgPool;
use time::{Date, OffsetDateTime, PrimitiveDateTime, Time, macros::offset};
use uuid::Uuid;

#[derive(sqlx::FromRow)]
struct Change {
    id: Uuid,
    code: String,
    target_label: String,
    effective_date: Date,
    kind: String,
    waiting_role: Option<String>,
    created_at: OffsetDateTime,
    reason: String,
    drafted_by_name: Option<String>,
    command_id: Option<Uuid>,
}

// Keep membership identical for the exact count and keyset page.
macro_rules! eligible {
    () => {
        "WITH classified AS (SELECT r.id, r.code, r.target_label, r.effective_date, r.created_at, r.reason, \
         ((r.effective_date + 1)::timestamp AT TIME ZONE 'Asia/Seoul') - interval '1 microsecond' AS inbox_due, \
         (SELECT u.display_name FROM person_accounts_current u WHERE u.org_id = r.org_id AND u.id = r.drafted_by) AS drafted_by_name, \
         (SELECT e.command_id FROM audit_events e WHERE e.org_id = r.org_id \
          AND e.target_type = 'org_change_request' AND e.target_id = r.id::text \
          AND e.outcome = 'ALLOWED' AND e.command_id IS NOT NULL \
          ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS command_id, \
         (SELECT s.role_key FROM org_change_approval_steps s \
          WHERE s.org_id = r.org_id AND s.request_id = r.id AND s.decision = 'PENDING' \
          ORDER BY s.step_order LIMIT 1) AS waiting_role, \
         CASE \
          WHEN r.drafted_by = $2 AND r.status IN ('DRAFT','PRECHECKED') AND $5 THEN 'org_change_draft' \
          WHEN r.drafted_by = $2 AND r.status = 'REJECTED' AND $5 \
           AND NOT EXISTS (SELECT 1 FROM org_change_requests n WHERE n.org_id = r.org_id AND n.supersedes_id = r.id) \
           THEN 'org_change_rejected' \
          WHEN r.drafted_by = $2 AND r.status = 'SETTLING' AND $7 THEN 'org_change_settle' \
          WHEN r.status = 'APPROVED' AND (r.drafted_by = $2 OR $8) AND r.effective_date > $4 \
           THEN 'org_change_scheduled' \
          WHEN r.status = 'APPROVED' AND (r.drafted_by = $2 OR $8) AND r.effective_date <= $4 AND $7 \
           THEN 'org_change_apply' \
          WHEN r.drafted_by = $2 AND r.status IN ('IN_APPROVAL','APPROVED') THEN 'org_change_waiting' \
          WHEN r.status = 'IN_APPROVAL' AND r.id = ANY($6::uuid[]) \
           AND EXISTS (SELECT 1 FROM org_change_approval_steps s WHERE s.org_id = r.org_id \
            AND s.request_id = r.id AND s.decision = 'PENDING') THEN 'org_change_approve' \
         END AS kind \
         FROM org_change_requests r WHERE r.org_id = $1 AND r.created_at <= $3), \
         eligible AS (SELECT * FROM classified WHERE kind IS NOT NULL \
         AND ($9 = 'all' OR ($9 = 'turn' AND kind NOT IN ('org_change_waiting','org_change_scheduled')) \
           OR ($9 = 'waiting' AND kind = 'org_change_waiting') \
           OR ($9 = 'scheduled' AND kind = 'org_change_scheduled') OR $9 = 'deadlines')) "
    };
}

// Match orgchange-rest's feature floor, including its legacy matrix fallback.
pub(crate) fn holds(principal: &Principal, feature: Feature) -> bool {
    principal
        .roles
        .iter()
        .any(|role| permission_for(*role, feature) == PermissionLevel::Allow)
        || authorize_capability(principal, Action::new(feature)).is_ok()
}

pub(crate) async fn page(
    pool: &PgPool,
    principal: &Principal,
    query: ActionInboxSourceQuery,
) -> Result<ActionInboxSourcePage, KernelError> {
    if !holds(principal, Feature::OrgChangeRead) {
        return Ok(super::super::empty_source_page());
    }
    let principal = principal.clone();
    let org = principal.org_id;
    let draft = holds(&principal, Feature::OrgChangeDraft);
    let apply_others = holds(&principal, Feature::OrgChangeApply);
    let filter = match query.filter {
        console_action_inbox_application::InboxFilter::Turn => "turn",
        console_action_inbox_application::InboxFilter::Waiting => "waiting",
        console_action_inbox_application::InboxFilter::Scheduled => "scheduled",
        console_action_inbox_application::InboxFilter::Deadlines => "deadlines",
        _ => "all",
    };
    let (rows, total) = with_org_conn::<_, _, AppError>(pool, org, move |tx| {
        Box::pin(async move {
            let approve: Vec<Uuid> = console_orgchange_adapter_postgres::step_decision_facts_in_tx(
                tx, org, principal.user_id, None,
            ).await.map_err(|e| AppError::Internal(e.to_string()))?
                .into_iter().filter_map(|(id, facts)| {
                    console_platform_authz::cedar_pbac::actions::org_change_step_decide::enforce(
                        &principal.user_id.to_string(), &org.to_string(), &org.to_string(), facts,
                    ).is_ok().then_some(id)
                }).collect();
            let apply = apply_others
                || (draft
                    && !approval_routes_in_tx(
                        tx.as_mut(),
                        org,
                        SettingKey::ApprovalPolicyOrgStructure,
                    )
                    .await
                    .map_err(|error| AppError::Internal(error.to_string()))?);
            let today = query.now.to_offset(offset!(+9)).date();
            let count: i64 =
                sqlx::query_scalar(concat!(eligible!(), "SELECT count(*) FROM eligible"))
                    .bind(org.as_uuid())
                    .bind(principal.user_id.as_uuid())
                    .bind(query.as_of)
                    .bind(today)
                    .bind(draft)
                    .bind(&approve)
                    .bind(apply)
                    .bind(apply_others)
                    .bind(filter)
                    .fetch_one(tx.as_mut())
                    .await?;
            let rows = sqlx::query_as::<_, Change>(concat!(
                eligible!(),
                "SELECT * FROM eligible WHERE ($11::text IS NULL \
                 OR inbox_due > $10 OR (inbox_due = $10 AND (created_at, ('org_change:' || id::text)) > ($12, $11))) \
                 ORDER BY inbox_due ASC NULLS LAST, created_at, id LIMIT $13"
            ))
            .bind(org.as_uuid())
            .bind(principal.user_id.as_uuid())
            .bind(query.as_of)
            .bind(today)
            .bind(draft)
            .bind(&approve)
            .bind(apply)
            .bind(apply_others)
            .bind(filter)
            .bind(query.after.as_ref().and_then(|p| p.due))
            .bind(query.after.as_ref().map(|p| p.id.clone()))
            .bind(query.after.as_ref().map(|p| p.created_at))
            .bind(i64::try_from(query.limit.saturating_add(1)).unwrap_or(i64::MAX))
            .fetch_all(tx.as_mut())
            .await?;
            Ok((rows, count))
        })
    })
    .await
    .map_err(|error| super::super::source_failure("org_change", error))?;
    let has_more = rows.len() > query.limit;
    Ok(ActionInboxSourcePage {
        items: rows
            .into_iter()
            .take(query.limit)
            .map(|row| ActionInboxSourceItem {
                context: Some(serde_json::json!({"command": match row.kind.as_str() { "org_change_approve" => Some("approve"), "org_change_apply" => Some("effectuate"), _ => None }, "reason": row.reason, "drafter": row.drafted_by_name.unwrap_or_default(), "command_id": row.command_id })),
                id: format!("org_change:{}", row.id),
                kind: row.kind,
                ref_code: row.code,
                title: row.target_label,
                site: None,
                who: row.waiting_role,
                due: Some(
                    PrimitiveDateTime::new(row.effective_date, Time::MAX - time::Duration::nanoseconds(999))
                        .assume_offset(offset!(+9)),
                ),
                submitted: None,
                links: vec![ActionInboxLink {
                    kind: "org_change".into(),
                    id: row.id.to_string(),
                    label: None,
                }],
                created_at: row.created_at,
            })
            .collect(),
        total: usize::try_from(total).unwrap_or(0),
        total_is_exact: true,
        has_more,
    })
}

#[cfg(test)]
#[path = "org_change_tests.rs"]
mod tests;
