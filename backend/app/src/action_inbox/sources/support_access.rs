// SPDX-License-Identifier: LicenseRef-Proprietary
//! Tenant support approvals share the decision endpoint's catalog permission.
use console_action_inbox_application::{
    ActionInboxLink, ActionInboxSourceItem, ActionInboxSourcePage, ActionInboxSourceQuery,
};
use console_kernel_core::KernelError;
use console_platform_authz::Principal;
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(sqlx::FromRow)]
struct Pending {
    id: Uuid,
    ticket_ref: String,
    reason: String,
    operator_label: String,
    request_expires_at: OffsetDateTime,
    requested_at: OffsetDateTime,
}

pub(crate) async fn page(
    pool: &PgPool,
    principal: &Principal,
    query: ActionInboxSourceQuery,
) -> Result<ActionInboxSourcePage, KernelError> {
    let failure = |_| KernelError::internal("failed to load support approvals");
    let mut tx = pool.begin().await.map_err(failure)?;
    let allowed = console_platform_rest::tenant_support_permission(
        &mut tx,
        principal.org_id,
        *principal.user_id.as_uuid(),
    )
    .await
    .map_err(|_| KernelError::internal("failed to authorize support approvals"))?;
    if !allowed {
        return Ok(super::super::empty_source_page());
    }
    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM support_sessions WHERE org_id=$1 AND state='OPERATOR_APPROVED' AND tenant_approved_at IS NULL AND request_expires_at>$2 AND requested_at<=$3")
        .bind(principal.org_id.as_uuid()).bind(query.now).bind(query.as_of)
        .fetch_one(tx.as_mut()).await.map_err(failure)?;
    let (after_at, after_id) = query
        .after
        .map(|p| (Some(p.created_at), p.id))
        .unwrap_or_default();
    let mut rows = sqlx::query_as::<_, Pending>("SELECT id,ticket_ref,reason,operator_label,request_expires_at,requested_at FROM support_sessions WHERE org_id=$1 AND state='OPERATOR_APPROVED' AND tenant_approved_at IS NULL AND request_expires_at>$2 AND requested_at<=$3 AND ($4::timestamptz IS NULL OR (requested_at,'support_access:'||id::text)>($4,$5)) ORDER BY requested_at,id LIMIT $6")
        .bind(principal.org_id.as_uuid()).bind(query.now).bind(query.as_of).bind(after_at).bind(after_id)
        .bind(i64::try_from(query.limit.saturating_add(1)).map_err(|_| KernelError::validation("invalid inbox limit"))?)
        .fetch_all(tx.as_mut()).await.map_err(failure)?;
    tx.commit().await.map_err(failure)?;
    let has_more = rows.len() > query.limit;
    rows.truncate(query.limit);
    Ok(ActionInboxSourcePage {
        items: rows
            .into_iter()
            .map(|s| ActionInboxSourceItem {
                id: format!("support_access:{}", s.id),
                kind: "support_access".into(),
                ref_code: s.ticket_ref,
                title: s.reason,
                site: None,
                who: Some(s.operator_label),
                due: Some(s.request_expires_at),
                submitted: Some(s.requested_at),
                created_at: s.requested_at,
                links: vec![ActionInboxLink {
                    kind: "support_session".into(),
                    id: s.id.to_string(),
                    label: None,
                }],
            })
            .collect(),
        total: usize::try_from(total)
            .map_err(|_| KernelError::internal("invalid support approval count"))?,
        total_is_exact: true,
        has_more,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use console_action_inbox_application::ActionInboxPosition;
    use console_kernel_core::{BranchScope, OrgId};
    use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
    use time::Duration;

    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn snapshot_filters_both_support_rows_and_totals(pool: PgPool) {
        let org = OrgId::new();
        let user = seed_org_and_super_admin(&pool, *org.as_uuid(), "support-snapshot").await;
        sqlx::query("UPDATE users SET is_tenant_ops=true WHERE org_id=$1 AND id=$2")
            .bind(org.as_uuid())
            .bind(user.as_uuid())
            .execute(&pool)
            .await
            .unwrap();
        let as_of: OffsetDateTime = sqlx::query_scalar("SELECT clock_timestamp()")
            .fetch_one(&pool)
            .await
            .unwrap();
        let mut ids = Vec::new();
        for requested_at in [as_of - Duration::SECOND, as_of, as_of + Duration::SECOND] {
            let id = Uuid::new_v4();
            sqlx::query("INSERT INTO support_sessions(org_id,id,operator_ref,operator_label,ticket_ref,reason_code,reason,scope,requested_duration_seconds,state,requested_at,request_expires_at,request_assertion,operator_approver_ref,operator_approved_at,approval_assertion) VALUES($1,$2,gen_random_uuid(),'공급사 운영자','SNAPSHOT','DIAGNOSE','조회 확인',ARRAY['org'],60,'OPERATOR_APPROVED',$3,$4,gen_random_uuid(),gen_random_uuid(),$3,gen_random_uuid())")
                .bind(org.as_uuid()).bind(id).bind(requested_at).bind(as_of + Duration::HOUR)
                .execute(&pool).await.unwrap();
            ids.push(format!("support_access:{id}"));
        }
        let pool = runtime_role_pool(&pool).await;
        let principal = Principal::new(user, org, Default::default(), BranchScope::All);
        let mut query = ActionInboxSourceQuery {
            now: as_of + Duration::seconds(2),
            as_of,
            after: None,
            limit: 1,
        };
        let first = page(&pool, &principal, query.clone()).await.unwrap();
        assert_eq!(first.total, 2);
        assert!(first.total_is_exact);
        assert!(first.has_more);
        assert_eq!(first.items[0].id, ids[0]);
        query.after = Some(ActionInboxPosition {
            created_at: first.items[0].created_at,
            id: first.items[0].id.clone(),
        });
        let second = page(&pool, &principal, query.clone()).await.unwrap();
        assert_eq!(second.total, 2);
        assert!(!second.has_more);
        assert_eq!(second.items.len(), 1);
        assert_eq!(second.items[0].id, ids[1]);
        query.after = None;
        query.limit = 10;
        let all = page(&pool, &principal, query.clone()).await.unwrap();
        assert_eq!(
            all.items.iter().map(|item| &item.id).collect::<Vec<_>>(),
            ids[..2].iter().collect::<Vec<_>>()
        );
        query.as_of -= Duration::seconds(2);
        let empty = page(&pool, &principal, query).await.unwrap();
        assert_eq!(empty.total, 0);
        assert!(empty.items.is_empty());
        assert!(!empty.has_more);
    }
}
