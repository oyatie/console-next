// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_action_inbox_application::ActionInboxPosition;
use console_kernel_core::{BranchScope, OrgId, UserId};
use console_platform_authz::Role;
use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use std::collections::BTreeSet;
use time::Duration;

async fn failed_events(pool: &PgPool) -> (OrgId, UserId, [Uuid; 3], OffsetDateTime) {
    let org = OrgId::new();
    let user = seed_org_and_super_admin(pool, *org.as_uuid(), "inbox-failed-cursor").await;
    let now: OffsetDateTime = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(pool)
        .await
        .unwrap();
    let ids = [Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()];
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role=replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    let employee: Uuid = sqlx::query_scalar(
        "INSERT INTO employees (org_id,company,name,source_filename,source_sheet,source_row,source_key) \
         VALUES ($1,'회사','김직원','console','console',1,'inbox-failed-cursor') RETURNING id",
    )
    .bind(org.as_uuid())
    .fetch_one(tx.as_mut())
    .await
    .unwrap();
    for (id, minutes) in ids.into_iter().zip([3, 2, 1]) {
        sqlx::query(
            "INSERT INTO employee_lifecycle_events (org_id,id,employee_id,event_type,to_status,effective_date,comment,created_by,state,created_at,failure_code,failure_reason) \
             VALUES ($1,$2,$3,'ONBOARD','ACTIVE',(now() AT TIME ZONE 'Asia/Seoul')::date::text,'업무함 검증',$4,'APPLY_FAILED',$5,'apply_failed','업무함 검증')",
        )
        .bind(org.as_uuid())
        .bind(id)
        .bind(employee)
        .bind(user.as_uuid())
        .bind(now - Duration::minutes(minutes))
        .execute(tx.as_mut())
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
    (org, user, ids, now)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn foreign_source_cursor_respects_timestamp_and_namespaced_ties(pool: PgPool) {
    let (org, user, [_, tied, newer], now) = failed_events(&pool).await;
    let principal = Principal::new(
        user,
        org,
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    );
    let runtime = runtime_role_pool(&pool).await;
    for (namespace, expected, more) in [("hr_register", newer, false), ("grant_notice", tied, true)]
    {
        let actual = page(
            &runtime,
            &principal,
            ActionInboxSourceQuery {
                filter: Default::default(),
                require_exact_total: false,
                now,
                as_of: now,
                after: Some(ActionInboxPosition {
                    created_at: now - Duration::minutes(2),
                    id: format!("{namespace}:{}", Uuid::new_v4()),
                }),
                limit: 1,
            },
        )
        .await
        .unwrap();
        assert_eq!(actual.total, 3);
        assert!(actual.total_is_exact);
        assert_eq!(actual.items.len(), 1);
        assert_eq!(actual.items[0].id, format!("hr_lifecycle:{expected}"));
        assert_eq!(actual.items[0].kind, "lifecycle_apply_failed");
        assert!(actual.items[0].ref_code.is_empty());
        assert_eq!(
            actual.items[0].context.as_ref().unwrap()["lifecycle"]["action_kind"],
            "ONBOARD"
        );
        assert_eq!(actual.has_more, more);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn refused_reader_sees_neither_failed_events_nor_their_count(pool: PgPool) {
    let (org, user, _, now) = failed_events(&pool).await;
    let principal = Principal::new(user, org, BTreeSet::new(), BranchScope::All);
    let actual = page(
        &runtime_role_pool(&pool).await,
        &principal,
        ActionInboxSourceQuery {
            filter: Default::default(),
            require_exact_total: false,
            now,
            as_of: now,
            after: None,
            limit: 1,
        },
    )
    .await
    .unwrap();
    assert!(actual.items.is_empty());
    assert_eq!(actual.total, 0);
    assert!(actual.total_is_exact);
    assert!(!actual.has_more);
}
