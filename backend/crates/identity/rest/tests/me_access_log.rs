// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[path = "me_access_log/helpers.rs"]
mod helpers;

use console_kernel_core::{OrgId, UserId};
use helpers::{
    Harness, get, record_access_audit, seed_employee_link, seed_org, seed_org_unit, seed_user,
};
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn me_access_log_rejects_unauthenticated_and_platform_tokens(pool: PgPool) {
    let harness = Harness::new(pool.clone()).await;
    let (status, _) = get(&harness, "/api/v1/me/access-log", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let root: uuid::Uuid = sqlx::query_scalar("SELECT platform_ensure_cold_start_admin()")
        .fetch_one(&pool)
        .await
        .unwrap();
    let platform_token = harness
        .token(OrgId::platform(), UserId::from_uuid(root), true)
        .await;
    let (status, _) = get(&harness, "/api/v1/me/access-log", Some(&platform_token)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn me_access_log_is_empty_without_audit_view_or_employee_link(pool: PgPool) {
    let harness = Harness::new(pool.clone()).await;
    let user = seed_user(&pool, OrgId::one(), "New Hire").await;
    let token = harness.token(OrgId::one(), user, false).await;

    let (status, body) = get(&harness, "/api/v1/me/access-log", Some(&token)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["items"], json!([]));
    assert_eq!(body["next_cursor"], Value::Null);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn me_access_log_isolates_subjects_tenants_excludes_self_and_denied_and_redacts_pii(
    pool: PgPool,
) {
    let harness = Harness::new(pool.clone()).await;
    let org_a = OrgId::one();
    let org_b = OrgId::new();
    seed_org(&pool, org_b, "access-log-other").await;

    let hr_actor = seed_user(&pool, org_a, "HR Actor").await;
    let hr_unit = seed_org_unit(&pool, org_a, hr_actor, "HR Team").await;
    seed_employee_link(&pool, org_a, hr_actor, "HR-001", "HR Actor", Some(hr_unit)).await;

    let user_a = seed_user(&pool, org_a, "Employee A").await;
    let emp_a = seed_employee_link(&pool, org_a, user_a, "EMP-A", "Employee A", None).await;
    let user_b = seed_user(&pool, org_a, "Employee B").await;
    let emp_b = seed_employee_link(&pool, org_a, user_b, "EMP-B", "Employee B", None).await;
    let user_c = seed_user(&pool, org_b, "Employee C").await;
    let emp_c = seed_employee_link(&pool, org_b, user_c, "EMP-C", "Employee C", None).await;

    let base = OffsetDateTime::now_utc() - Duration::minutes(10);
    // Oldest allowed event for A (RRN reveal with raw PII/note seeded in snapshot to prove non-leak).
    record_access_audit(
        &pool,
        org_a,
        hr_actor,
        "employee.rrn_reveal",
        ("employee", &emp_a.to_string()),
        base,
        json!({
            "subject_ids": [emp_a],
            "self_read": false,
            "field": "RRN",
            "reason_code": "SOCIAL_INSURANCE_FILING",
            "note": "secret-note 900101-1234567",
            "raw_value": "900101-1234567"
        }),
    )
    .await;
    // Second allowed event for A (phone reveal).
    record_access_audit(
        &pool,
        org_a,
        hr_actor,
        "employee.field_reveal",
        ("employee", &emp_a.to_string()),
        base + Duration::seconds(10),
        json!({
            "subject_ids": [emp_a],
            "self_read": false,
            "field": "PHONE",
            "reason_code": "IDENTITY_VERIFICATION",
            "purpose_note": "010-1234-5821"
        }),
    )
    .await;
    // Third allowed event for A (user-targeted account read).
    record_access_audit(
        &pool,
        org_a,
        hr_actor,
        "account.read",
        ("user", &user_a.to_string()),
        base + Duration::seconds(20),
        json!({
            "subject_ids": [user_a],
            "self_read": false
        }),
    )
    .await;
    // Excluded: A's own self_read.
    record_access_audit(
        &pool,
        org_a,
        user_a,
        "employee.read",
        ("employee", &emp_a.to_string()),
        base + Duration::seconds(30),
        json!({
            "subject_ids": [emp_a],
            "self_read": true
        }),
    )
    .await;
    // Excluded: DENIED attempt on A.
    record_access_audit(
        &pool,
        org_a,
        hr_actor,
        "employee.rrn_reveal.refused",
        ("employee", &emp_a.to_string()),
        base + Duration::seconds(40),
        json!({
            "subject_ids": [emp_a],
            "self_read": false,
            "field": "RRN"
        }),
    )
    .await;
    // Excluded: coworker B in same org.
    record_access_audit(
        &pool,
        org_a,
        hr_actor,
        "employee.rrn_reveal",
        ("employee", &emp_b.to_string()),
        base + Duration::seconds(50),
        json!({
            "subject_ids": [emp_b],
            "self_read": false,
            "field": "RRN",
            "reason_code": "PAYROLL_WITHHOLDING"
        }),
    )
    .await;
    // Excluded: employee C in other org.
    record_access_audit(
        &pool,
        org_b,
        user_c,
        "employee.rrn_reveal",
        ("employee", &emp_c.to_string()),
        base + Duration::seconds(60),
        json!({
            "subject_ids": [emp_c],
            "self_read": false,
            "field": "RRN"
        }),
    )
    .await;

    let token_a = harness.token(org_a, user_a, false).await;
    let token_b = harness.token(org_a, user_b, false).await;
    let token_c = harness.token(org_b, user_c, false).await;

    let (status, page1) = get(&harness, "/api/v1/me/access-log?limit=2", Some(&token_a)).await;
    assert_eq!(status, StatusCode::OK, "{page1}");
    let items1 = page1["items"].as_array().unwrap();
    assert_eq!(items1.len(), 2, "{page1}");
    assert_eq!(items1[0]["action"], "account.read");
    assert_eq!(items1[1]["action"], "employee.field_reveal");
    assert_eq!(items1[1]["field"], "PHONE");
    assert_eq!(items1[1]["reason_code"], "IDENTITY_VERIFICATION");
    let cursor = page1["next_cursor"]
        .as_str()
        .expect("next_cursor present")
        .to_owned();

    let (status, page2) = get(
        &harness,
        &format!("/api/v1/me/access-log?limit=2&cursor={cursor}"),
        Some(&token_a),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{page2}");
    let items2 = page2["items"].as_array().unwrap();
    assert_eq!(items2.len(), 1, "{page2}");
    assert_eq!(items2[0]["action"], "employee.rrn_reveal");
    assert_eq!(items2[0]["actor_name"], "HR Actor");
    assert_eq!(items2[0]["actor_team"], "HR Team");
    assert_eq!(items2[0]["field"], "RRN");
    assert_eq!(items2[0]["reason_code"], "SOCIAL_INSURANCE_FILING");
    assert_eq!(items2[0]["target_type"], "employee");
    assert_eq!(page2["next_cursor"], Value::Null);

    let serialized = format!("{page1}{page2}");
    for forbidden in [
        "900101-1234567",
        "010-1234-5821",
        "secret-note",
        &emp_b.to_string(),
        &emp_c.to_string(),
    ] {
        assert!(
            !serialized.contains(forbidden),
            "forbidden value {forbidden} leaked: {serialized}"
        );
    }

    // Foreign user's cursor and bad limits/cursors return 422.
    for invalid in [
        "/api/v1/me/access-log?limit=0",
        "/api/v1/me/access-log?limit=101",
        "/api/v1/me/access-log?cursor=bogus",
    ] {
        let (status, err) = get(&harness, invalid, Some(&token_a)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{err}");
    }
    for foreign_token in [&token_b, &token_c] {
        let (status, err) = get(
            &harness,
            &format!("/api/v1/me/access-log?cursor={cursor}"),
            Some(foreign_token),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{err}");
    }
}
