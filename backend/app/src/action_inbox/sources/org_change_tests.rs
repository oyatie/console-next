// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_kernel_core::{BranchScope, OrgId, UserId};
use console_platform_authz::Role;
use console_platform_test_support::{
    runtime_role_pool, seed_active_user, seed_org_and_super_admin,
};
use std::collections::BTreeSet;
use time::OffsetDateTime;
use uuid::Uuid;

mod org_grants {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../test-support/org_change_fixtures.rs"
    ));
}

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
    org_grants::grant_org_approve(&pool, me).await;
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
    let actual = page(&runtime_role_pool(&pool).await, &principal, query.clone())
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

    sqlx::query("UPDATE access_grants SET valid_to=now()-interval '1 second' WHERE account_id=$1")
        .bind(me.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let without_grant = page(&runtime_role_pool(&pool).await, &principal, query)
        .await
        .unwrap();
    assert_eq!(without_grant.total, 7);
    assert_eq!(without_grant.items.len(), 7);
    assert!(without_grant.total_is_exact);
    assert!(
        without_grant
            .items
            .iter()
            .all(|i| i.kind != "org_change_approve")
    );

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
