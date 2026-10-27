// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use super::support::{arm, event, policy};
use console_kernel_core::OrgId;
use console_platform_access::log_review::list::{page_in_tx, prepare_in_tx};
use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use serde_json::json;
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn local_midnight_and_ingestion_boundaries_preserve_counts_and_minimisation(pool: PgPool) {
    let org = OrgId::new();
    let user = seed_org_and_super_admin(&pool, *org.as_uuid(), "boundaries").await;
    policy(&pool, org, user, "bulk_subjects_min", 10).await;
    sqlx::query("INSERT INTO tenant_setting_overrides(org_id,key,value,set_by,reason_code) VALUES($1,'access_log_review.flag.every_download','false',$2,'POLICY_REVIEW')")
        .bind(org.as_uuid()).bind(user.as_uuid()).execute(&pool).await.unwrap();
    let hidden_subject = uuid::Uuid::new_v4();
    for occurred in ["2026-09-01T14:59:59Z", "2026-09-01T15:00:00Z"] {
        event(&pool, org, user, "employee.export", occurred,
            json!({"subject_count":6,"subject_ids":[hidden_subject],"export_purpose":"AUDIT","row_count":6})).await;
    }
    // Late-arriving old activity belongs to the ingestion month, outside this fixed interval.
    sqlx::query("INSERT INTO audit_events(org_id,actor,action,target_type,target_id,trace_id,span_id,occurred_at,created_at,after_snap) VALUES($1,$2,'employee.rrn_reveal','employee','late',repeat('a',32),repeat('b',16),'2026-09-01T02:00:00Z','2026-10-01T00:00:00Z','{\"self_read\":false}')")
        .bind(org.as_uuid()).bind(user.as_uuid()).execute(&pool).await.unwrap();
    let rt = runtime_role_pool(&pool).await;
    let mut tx = arm(&rt, org).await;
    let snapshot = prepare_in_tx(tx.as_mut(), org, "2026-09").await.unwrap();
    assert_eq!(
        snapshot.disabled_flags(),
        vec!["download", "repeated_denial"]
    );
    assert_eq!(snapshot.totals()["events"], 2);
    assert_eq!(snapshot.totals()["by_flag"]["bulk_subjects"], 0);
    let rows = page_in_tx(tx.as_mut(), &snapshot, None, 200, true)
        .await
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|row| row.flags == ["off_hours"]));
    let frozen = serde_json::to_string(&snapshot).unwrap();
    assert!(!frozen.contains(&hidden_subject.to_string()));
    assert!(!frozen.contains("subject_ids"));
    let empty = prepare_in_tx(tx.as_mut(), org, "2026-08").await.unwrap();
    assert_eq!(empty.totals()["events"], 0);
    assert_eq!(empty.totals()["flagged"], 0);
    assert!(
        empty.totals()["by_flag"]
            .as_object()
            .unwrap()
            .values()
            .all(|n| *n == 0)
    );
    assert!(
        page_in_tx(tx.as_mut(), &empty, None, 50, true)
            .await
            .unwrap()
            .is_empty()
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn covered_directory_identity_exit_and_attendance_actions_reach_the_same_projection(
    pool: PgPool,
) {
    let org = OrgId::new();
    let user = seed_org_and_super_admin(&pool, *org.as_uuid(), "coverage").await;
    let mut ids = Vec::new();
    for action in [
        "employee.list_read",
        "employee.lifecycle_read",
        "employee.org_chart_read",
        "person_binding_reviews.read",
        "employee_exit_case.list_read",
        "employee_exit_case.read",
        "directory.list_read",
        "account.list_read",
        "account.read",
        "attendance.day_read",
        "attendance.month_read",
        "attendance.person_month_read",
    ] {
        ids.push(
            event(
                &pool,
                org,
                user,
                action,
                "2026-09-01T02:00:00Z",
                json!({"subject_count":1}),
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
    assert_eq!(rows.len(), ids.len());
    for id in ids {
        assert!(rows.iter().any(|r| r.event_id == id && r.flags.is_empty()));
    }
}
