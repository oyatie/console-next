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
          WHEN r.status = 'IN_APPROVAL' AND $6 \
           AND EXISTS (SELECT 1 FROM org_change_approval_steps s WHERE s.org_id = r.org_id \
            AND s.request_id = r.id AND s.decision = 'PENDING') \
           AND public.console_independent_people($1, r.drafted_by, $2) THEN 'org_change_approve' \
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
    let approve = holds(&principal, Feature::OrgChangeApprove);
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
                    .bind(approve)
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
            .bind(approve)
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
mod tests {
    use super::*;
    use console_kernel_core::{BranchScope, OrgId, UserId};
    use console_platform_authz::Role;
    use console_platform_test_support::{
        runtime_role_pool, seed_active_user, seed_org_and_super_admin,
    };
    use std::collections::BTreeSet;
    use time::OffsetDateTime;
    use uuid::Uuid;

    mod people {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../test-support/person_fixtures.rs"
        ));
    }

    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn org_change_inbox_preserves_every_home_lane_and_refuses_self_approval(pool: PgPool) {
        let org = OrgId::new();
        let me = seed_org_and_super_admin(&pool, *org.as_uuid(), "inbox-org").await;
        let other = seed_active_user(&pool, *org.as_uuid(), "ADMIN", "maker").await;
        people::bind_user_to_distinct_person(&pool, me).await;
        people::bind_user_to_distinct_person(&pool, other).await;
        let principal = Principal::new(
            me,
            org,
            BTreeSet::from([Role::SuperAdmin]),
            BranchScope::All,
        );
        for (index, (status, maker, days)) in [
            ("DRAFT", me, 0),
            ("PRECHECKED", me, 0),
            ("REJECTED", me, 0),
            ("SETTLING", me, 0),
            ("APPROVED", me, 0),
            ("APPROVED", me, 1),
            ("IN_APPROVAL", me, 0),
            ("IN_APPROVAL", other, 0),
            ("DRAFT", other, 0),
            ("CANCELLED", me, 0),
        ]
        .into_iter()
        .enumerate()
        {
            let request: Uuid = sqlx::query_scalar(
                "INSERT INTO org_change_requests (org_id, code, kind, status, target_kind, \
                 target_ref, target_label, effective_date, reason, drafted_by, idempotency_key, request_fingerprint) \
                 VALUES ($1,$2,'REORG',$3,'REGION','region','조직 개편', \
                 (now() AT TIME ZONE 'Asia/Seoul')::date + $4, '업무함 검증',$5,$6,repeat('a',64)) RETURNING id"
            ).bind(org.as_uuid()).bind(format!("OC-2026-{:04}", index + 1))
                .bind(status).bind(days).bind(maker.as_uuid()).bind(Uuid::new_v4().to_string())
                .fetch_one(&pool).await.unwrap();
            if status == "IN_APPROVAL" {
                sqlx::query("INSERT INTO org_change_approval_steps (org_id,request_id,step_order,role_key) VALUES ($1,$2,1,'hr')")
                    .bind(org.as_uuid()).bind(request).execute(&pool).await.unwrap();
            }
        }
        let now = sqlx::query_scalar("SELECT clock_timestamp()")
            .fetch_one(&pool)
            .await
            .unwrap();
        let query = ActionInboxSourceQuery {
            filter: Default::default(),
            require_exact_total: false,
            now,
            as_of: now,
            after: None,
            limit: 20,
        };
        let actual = page(&runtime_role_pool(&pool).await, &principal, query)
            .await
            .unwrap();
        assert_eq!(actual.total, 8);
        for kind in [
            "org_change_draft",
            "org_change_rejected",
            "org_change_settle",
            "org_change_apply",
            "org_change_scheduled",
            "org_change_waiting",
            "org_change_approve",
        ] {
            assert!(
                actual.items.iter().any(|i| i.kind == kind),
                "missing {kind}"
            );
        }
        assert!(
            actual
                .items
                .iter()
                .all(|i| i.id.starts_with("org_change:") && i.due.is_some())
        );
        for (kind, command) in [
            ("org_change_approve", "approve"),
            ("org_change_apply", "effectuate"),
        ] {
            let row = actual.items.iter().find(|item| item.kind == kind).unwrap();
            let context = row.context.as_ref().unwrap();
            assert_eq!(context["command"], command);
            assert!(!context["reason"].as_str().unwrap().is_empty());
            assert!(!context["drafter"].as_str().unwrap().is_empty());
        }

        let denied = Principal::new(me, org, BTreeSet::new(), BranchScope::All);
        let no_items = page(
            &runtime_role_pool(&pool).await,
            &denied,
            ActionInboxSourceQuery {
                filter: Default::default(),
                require_exact_total: false,
                now,
                as_of: now,
                after: None,
                limit: 20,
            },
        )
        .await
        .unwrap();
        assert_eq!(no_items.total, 0);
    }

    #[tokio::test]
    async fn no_org_change_grant_does_not_query_or_disclose_a_source() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
            .unwrap();
        let principal = Principal::new(
            UserId::new(),
            OrgId::new(),
            BTreeSet::new(),
            BranchScope::All,
        );
        let now = OffsetDateTime::now_utc();
        let result = page(
            &pool,
            &principal,
            ActionInboxSourceQuery {
                filter: Default::default(),
                require_exact_total: false,
                now,
                as_of: now,
                after: None,
                limit: 10,
            },
        )
        .await
        .unwrap();
        assert!(result.items.is_empty());
        assert_eq!(result.total, 0);
    }
}
