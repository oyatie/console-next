// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "access_log_review_flags/attribution.rs"]
mod attribution;
#[path = "access_log_review_flags/boundaries.rs"]
mod boundaries;
#[path = "access_log_review_flags/statements.rs"]
mod statements;
#[path = "access_log_review_flags/support.rs"]
mod support;

use console_kernel_core::OrgId;
use console_platform_access::log_review::list::{page_in_tx, prepare_in_tx};
use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use serde_json::json;
use sqlx::PgPool;
use support::{arm, event, policy};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn frozen_rules_flag_access_rows_without_self_reads_or_review_feedback(pool: PgPool) {
    let org = OrgId::new();
    let user = seed_org_and_super_admin(&pool, *org.as_uuid(), "flags").await;
    let other_org = OrgId::new();
    let other = seed_org_and_super_admin(&pool, *other_org.as_uuid(), "other").await;
    policy(&pool, org, user, "bulk_subjects_min", 10).await;
    policy(&pool, org, user, "denied_min", 3).await;
    policy(&pool, org, user, "off_hours_min", 2).await;
    let export = event(
        &pool,
        org,
        user,
        "employee.export",
        "2026-09-01T02:00:00Z",
        json!({"export_purpose":"AUDIT", "subject_count":1}),
    )
    .await;
    let off = event(
        &pool,
        org,
        user,
        "employee.read",
        "2026-09-01T12:00:00Z",
        json!({"subject_count":10}),
    )
    .await;
    let weekend = event(
        &pool,
        org,
        user,
        "employee.read",
        "2026-09-05T02:00:00Z",
        json!({}),
    )
    .await;
    let sensitive = event(
        &pool,
        org,
        user,
        "employee.rrn_reveal",
        "2026-09-02T02:00:00Z",
        json!({}),
    )
    .await;
    for _ in 0..3 {
        event(
            &pool,
            org,
            user,
            "employee.export_refused",
            "2026-09-01T02:00:00Z",
            json!({"denied":true}),
        )
        .await;
    }
    for _ in 0..2 {
        event(
            &pool,
            org,
            user,
            "employee.export",
            "2026-09-01T02:00:00Z",
            json!({"export_purpose":"AUDIT"}),
        )
        .await;
    }
    let self_read = event(
        &pool,
        org,
        user,
        "employee.export",
        "2026-09-02T12:00:00Z",
        json!({"self_read":true,"subject_count":10000,"export_purpose":"AUDIT"}),
    )
    .await;
    let review = event(
        &pool,
        org,
        user,
        "access_log.review_read",
        "2026-09-02T12:00:00Z",
        json!({"subject_count":10000,"export_purpose":"AUDIT"}),
    )
    .await;
    event(
        &pool,
        other_org,
        other,
        "employee.read",
        "2026-09-01T02:00:00Z",
        json!({}),
    )
    .await;
    let rt = runtime_role_pool(&pool).await;
    let mut tx = arm(&rt, org).await;
    let snapshot = prepare_in_tx(tx.as_mut(), org, "2026-09").await.unwrap();
    let rows = page_in_tx(tx.as_mut(), &snapshot, None, 200, false)
        .await
        .unwrap();
    assert_eq!(rows.len(), 11);
    let flags = |id| &rows.iter().find(|r| r.event_id == id).unwrap().flags;
    assert_eq!(
        flags(export),
        &["download", "download_repeat", "bulk_subjects"]
    );
    assert_eq!(flags(off), &["off_hours", "bulk_subjects"]);
    assert_eq!(flags(weekend), &["off_hours"]);
    assert_eq!(flags(sensitive), &["sensitive_read"]);
    assert!(flags(self_read).is_empty());
    assert!(flags(review).is_empty());
    assert_eq!(
        snapshot.totals(),
        &json!({"events":11,"flagged":9,"by_flag":{"download":3,"download_repeat":3,"off_hours":2,"bulk_subjects":2,"sensitive_read":1,"repeated_denial":3}})
    );
    let first = page_in_tx(tx.as_mut(), &snapshot, None, 4, true)
        .await
        .unwrap();
    let last = first.last().unwrap();
    let second = page_in_tx(
        tx.as_mut(),
        &snapshot,
        Some((last.created_at, last.event_id)),
        200,
        true,
    )
    .await
    .unwrap();
    let ids: Vec<_> = first.iter().chain(&second).map(|r| r.event_id).collect();
    assert_eq!(
        ids,
        rows.iter()
            .filter(|r| !r.flags.is_empty())
            .map(|r| r.event_id)
            .collect::<Vec<_>>()
    );
    tx.commit().await.unwrap();
    // Frozen calculations keep their original rule versions after a policy change.
    policy(&pool, org, user, "bulk_subjects_min", 100000).await;
    policy(&pool, org, user, "off_hours_min", 3).await;
    let mut tx = arm(&rt, org).await;
    assert_eq!(
        page_in_tx(tx.as_mut(), &snapshot, None, 200, false)
            .await
            .unwrap(),
        rows
    );
    let changed = prepare_in_tx(tx.as_mut(), org, "2026-09").await.unwrap();
    assert_eq!(changed.totals()["by_flag"]["bulk_subjects"], 0);
    assert_eq!(changed.totals()["by_flag"]["off_hours"], 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn missing_thresholds_disable_flags_and_period_and_limit_refusals_do_not_write(pool: PgPool) {
    let org = OrgId::new();
    let user = seed_org_and_super_admin(&pool, *org.as_uuid(), "unset").await;
    event(
        &pool,
        org,
        user,
        "employee.read",
        "2026-09-01T02:00:00Z",
        json!({"subject_count":1000000,"denied":true}),
    )
    .await;
    let rt = runtime_role_pool(&pool).await;
    let mut tx = arm(&rt, org).await;
    let snapshot = prepare_in_tx(tx.as_mut(), org, "2026-09").await.unwrap();
    assert_eq!(
        snapshot.disabled_flags(),
        vec!["bulk_subjects", "repeated_denial"]
    );
    assert_eq!(snapshot.totals()["flagged"], 0);
    for period in ["2026-9", "2026-13", "2026-00", "2026-09-01", "oops"] {
        assert_eq!(
            prepare_in_tx(tx.as_mut(), org, period)
                .await
                .unwrap_err()
                .code,
            "period_invalid"
        );
    }
    assert_eq!(
        prepare_in_tx(tx.as_mut(), org, "9998-12")
            .await
            .unwrap_err()
            .code,
        "period_not_closed"
    );
    for limit in [0, 201] {
        assert_eq!(
            page_in_tx(tx.as_mut(), &snapshot, None, limit, false)
                .await
                .unwrap_err()
                .code,
            "limit_out_of_range"
        );
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM audit_events")
            .fetch_one(tx.as_mut())
            .await
            .unwrap(),
        1
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn frozen_page_meets_budget_at_two_thousand_actors_and_two_hundred_thousand_rows(
    pool: PgPool,
) {
    support::performance(pool, false).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn sparse_frozen_flagged_pages_meet_budget_without_scanning_the_month(pool: PgPool) {
    support::performance(pool, true).await;
}
