// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use super::support::{arm, event, policy};
use console_kernel_core::OrgId;
use console_platform_access::log_review::list::{page_in_tx, prepare_in_tx};
use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use serde_json::{Value, json};
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn patterns_only_flag_contributing_rows_and_have_separate_actor_day_summaries(pool: PgPool) {
    let org = OrgId::new();
    let user = seed_org_and_super_admin(&pool, *org.as_uuid(), "attribution").await;
    policy(&pool, org, user, "bulk_subjects_min", 10).await;
    policy(&pool, org, user, "denied_min", 2).await;
    let innocent = event(
        &pool,
        org,
        user,
        "employee.read",
        "2026-09-01T02:00:00Z",
        json!({}),
    )
    .await;
    let bulk = event(
        &pool,
        org,
        user,
        "employee.read",
        "2026-09-01T02:00:00Z",
        json!({"subject_count":10}),
    )
    .await;
    let mut downloads = Vec::new();
    for _ in 0..3 {
        downloads.push(
            event(
                &pool,
                org,
                user,
                "employee.export",
                "2026-09-01T02:00:00Z",
                json!({"export_purpose":"AUDIT"}),
            )
            .await,
        );
    }
    let mut denied = Vec::new();
    for _ in 0..2 {
        denied.push(
            event(
                &pool,
                org,
                user,
                "employee.export_refused",
                "2026-09-01T02:00:00Z",
                json!({"denied":true}),
            )
            .await,
        );
    }
    let rt = runtime_role_pool(&pool).await;
    let mut tx = arm(&rt, org).await;
    let snapshot = prepare_in_tx(tx.as_mut(), org, "2026-09").await.unwrap();
    let rows = page_in_tx(tx.as_mut(), &snapshot, None, 200, false)
        .await
        .unwrap();
    let flags = |id| &rows.iter().find(|r| r.event_id == id).unwrap().flags;
    assert!(
        flags(innocent).is_empty(),
        "an allowed zero-subject read caused no pattern"
    );
    assert_eq!(flags(bulk), &["bulk_subjects"]);
    for id in downloads {
        assert_eq!(flags(id), &["download", "download_repeat"]);
    }
    for id in denied {
        assert_eq!(flags(id), &["repeated_denial"]);
    }
    let evidence = serde_json::to_value(&snapshot).unwrap();
    let summaries = evidence["summaries"].as_array().unwrap();
    assert_eq!(summaries.len(), 3);
    for (flag, count) in [
        ("download_repeat", 3),
        ("bulk_subjects", 10),
        ("repeated_denial", 2),
    ] {
        assert!(
            summaries.contains(&json!({"actor":user,"day":"2026-09-01","flag":flag,"count":count}))
        );
    }
    assert_eq!(snapshot.totals()["flagged"], 6);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn fixed_interval_excludes_exact_end_and_before_start(pool: PgPool) {
    let org = OrgId::new();
    let user = seed_org_and_super_admin(&pool, *org.as_uuid(), "fixed-interval").await;
    let inside = event(
        &pool,
        org,
        user,
        "employee.rrn_reveal",
        "2026-09-01T02:00:00Z",
        json!({}),
    )
    .await;
    // Separate inserts: audit_events rejects UPDATE, including in the fixture.
    for (id, created) in [
        ("before", "2026-08-31T14:59:59Z"),
        ("from", "2026-08-31T15:00:00Z"),
        ("to", "2026-09-30T15:00:00Z"),
    ] {
        sqlx::query("INSERT INTO audit_events(org_id,actor,action,target_type,target_id,trace_id,span_id,occurred_at,created_at,after_snap) VALUES($1,$2,'employee.rrn_reveal','employee',$3,repeat('a',32),repeat('b',16),'2026-09-01T02:00:00Z',$4::text::timestamptz,'{\"self_read\":false}')")
            .bind(org.as_uuid()).bind(user.as_uuid()).bind(id).bind(created).execute(&pool).await.unwrap();
    }
    let rt = runtime_role_pool(&pool).await;
    let mut tx = arm(&rt, org).await;
    let snapshot = prepare_in_tx(tx.as_mut(), org, "2026-09").await.unwrap();
    assert_eq!(snapshot.totals()["events"], 2);
    let before = page_in_tx(tx.as_mut(), &snapshot, None, 200, true)
        .await
        .unwrap();
    assert_eq!(before.len(), 2);
    assert!(before.iter().any(|r| r.event_id == inside));
    let all = page_in_tx(tx.as_mut(), &snapshot, None, 200, false)
        .await
        .unwrap();
    assert_eq!(all, before);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn frozen_flagged_keyset_ignores_late_commits(pool: PgPool) {
    let org = OrgId::new();
    let user = seed_org_and_super_admin(&pool, *org.as_uuid(), "late-commit").await;
    event(
        &pool,
        org,
        user,
        "employee.rrn_reveal",
        "2026-09-01T02:00:00Z",
        json!({}),
    )
    .await;
    let rt = runtime_role_pool(&pool).await;
    let mut tx = arm(&rt, org).await;
    let snapshot = prepare_in_tx(tx.as_mut(), org, "2026-09").await.unwrap();
    let before = page_in_tx(tx.as_mut(), &snapshot, None, 200, true)
        .await
        .unwrap();
    let late = event(
        &pool,
        org,
        user,
        "employee.rrn_reveal",
        "2026-09-01T02:00:00Z",
        json!({}),
    )
    .await;
    let after = page_in_tx(tx.as_mut(), &snapshot, None, 200, true)
        .await
        .unwrap();
    assert_eq!(after, before);
    assert!(!after.iter().any(|r| r.event_id == late));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn off_hours_uses_reference_weekends_and_public_holidays_and_freezes_them(pool: PgPool) {
    let org = OrgId::new();
    let user = seed_org_and_super_admin(&pool, *org.as_uuid(), "calendar").await;
    // The query must use reference data, rather than assuming ISO days 6/7.
    sqlx::query("UPDATE access_log_review_calendar SET weekend_isodays=ARRAY[2]::smallint[] WHERE time_zone='Asia/Seoul'").execute(&pool).await.unwrap();
    let tuesday = event(
        &pool,
        org,
        user,
        "employee.read",
        "2026-09-01T02:00:00Z",
        json!({}),
    )
    .await;
    let saturday = event(
        &pool,
        org,
        user,
        "employee.read",
        "2026-09-05T02:00:00Z",
        json!({}),
    )
    .await;
    let holiday = event(
        &pool,
        org,
        user,
        "employee.read",
        "2026-09-24T02:00:00Z",
        json!({}),
    )
    .await;
    let rt = runtime_role_pool(&pool).await;
    let mut tx = arm(&rt, org).await;
    let snapshot = prepare_in_tx(tx.as_mut(), org, "2026-09").await.unwrap();
    let rows = page_in_tx(tx.as_mut(), &snapshot, None, 200, false)
        .await
        .unwrap();
    for id in [tuesday, holiday] {
        assert_eq!(
            rows.iter().find(|r| r.event_id == id).unwrap().flags,
            ["off_hours"]
        );
    }
    assert!(
        rows.iter()
            .find(|r| r.event_id == saturday)
            .unwrap()
            .flags
            .is_empty()
    );
    let summaries: Value = serde_json::to_value(&snapshot).unwrap()["summaries"].clone();
    assert_eq!(summaries.as_array().unwrap().len(), 2);
    sqlx::query("UPDATE access_log_review_calendar SET weekend_isodays=ARRAY[6,7]::smallint[]")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM attendance_public_holidays")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        page_in_tx(tx.as_mut(), &snapshot, None, 200, false)
            .await
            .unwrap(),
        rows
    );
}
