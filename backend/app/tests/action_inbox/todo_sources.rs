// SPDX-License-Identifier: LicenseRef-Proprietary
//! The to-do sources read the caller's own requests: a support session reads
//! none, and every page of a side counts all of that side's requests, whatever
//! its cursor and limit, as the workbench's complete read requires.
use super::authorization_tests::sources;
use super::*;
use console_action_inbox_application::ActionInboxPosition;
use console_kernel_core::OrgId;
use console_platform_test_support::{
    runtime_role_pool, seed_active_user, seed_org_and_super_admin,
};
use uuid::Uuid;

/// A support session reads no to-do request, even under the account id of one who asked or was asked.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_support_session_reads_no_to_do_request(pool: PgPool) {
    let org = OrgId::new();
    let asker = seed_org_and_super_admin(&pool, *org.as_uuid(), "requests").await;
    let asked = seed_active_user(&pool, *org.as_uuid(), "MEMBER", "asked").await;
    sqlx::query("INSERT INTO todos (org_id, owner_user_id, assigned_by_user_id, body) VALUES ($1, $2, $3, 'Synthetic ask')")
        .bind(org.as_uuid()).bind(asked.as_uuid()).bind(asker.as_uuid()).execute(&pool).await.unwrap();
    let runtime = runtime_role_pool(&pool).await;
    let now = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&pool)
        .await
        .unwrap();
    let query = ActionInboxSourceQuery {
        filter: InboxFilter::All,
        require_exact_total: true,
        now,
        as_of: now,
        after: None,
        limit: 20,
    };
    for (account, source) in [
        (asked, ActionInboxSource::TodoAssigned),
        (asker, ActionInboxSource::TodoRequested),
    ] {
        let mut reader = sources(&runtime, org, account).await;
        let own = reader
            .list_source_page(source, query.clone())
            .await
            .unwrap();
        assert_eq!((own.items.len(), own.total), (1, 1), "{source:?}");
        reader.principal.support = Some(
            serde_json::from_value(serde_json::json!({
                "active": true, "org_id": org.as_uuid(), "operator_approved": true,
                "tenant_approved": true, "session_id": Uuid::new_v4(),
                "operator_label": "Support operator", "scope": ["org"], "reveal_classes": []
            }))
            .unwrap(),
        );
        let page = reader
            .list_source_page(source, query.clone())
            .await
            .unwrap();
        assert_eq!((page.items.len(), page.total), (0, 0), "{source:?}");
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn every_page_of_a_side_counts_all_its_requests(pool: PgPool) {
    let org = OrgId::new();
    let asker = seed_org_and_super_admin(&pool, *org.as_uuid(), "requests").await;
    let asked = seed_active_user(&pool, *org.as_uuid(), "MEMBER", "asked").await;
    sqlx::query("INSERT INTO todos (org_id, owner_user_id, assigned_by_user_id, body) SELECT $1, $2, $3, 'Synthetic ask' FROM generate_series(1, 3)")
        .bind(org.as_uuid()).bind(asked.as_uuid()).bind(asker.as_uuid()).execute(&pool).await.unwrap();
    let runtime = runtime_role_pool(&pool).await;
    let now = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&pool)
        .await
        .unwrap();
    let at = |item: &console_action_inbox_application::ActionInboxSourceItem| {
        Some(ActionInboxPosition {
            due: item.due,
            created_at: item.created_at,
            id: item.id.clone(),
        })
    };
    for (account, source) in [
        (asked, ActionInboxSource::TodoAssigned),
        (asker, ActionInboxSource::TodoRequested),
    ] {
        let reader = sources(&runtime, org, account).await;
        let read = |after, limit| {
            reader.list_source_page(
                source,
                ActionInboxSourceQuery {
                    filter: InboxFilter::All,
                    require_exact_total: true,
                    now,
                    as_of: now,
                    after,
                    limit,
                },
            )
        };
        let all = read(None, 20).await.unwrap();
        assert_eq!((all.items.len(), all.total, all.has_more), (3, 3, false));
        let first = read(None, 1).await.unwrap();
        assert_eq!(
            (&first.items[0].id, first.total, first.has_more),
            (&all.items[0].id, 3, true)
        );
        let next = read(at(&first.items[0]), 1).await.unwrap();
        assert_eq!(
            (&next.items[0].id, next.total, next.has_more),
            (&all.items[1].id, 3, true)
        );
        let end = read(at(&all.items[2]), 1).await.unwrap();
        assert_eq!(
            (end.items.len(), end.total, end.has_more),
            (0, 3, false),
            "{source:?}"
        );
    }
}
