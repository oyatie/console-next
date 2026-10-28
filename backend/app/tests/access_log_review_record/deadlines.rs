// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{completion::*, *};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn review_deadline_applies_before_start_and_stays_frozen_after_start(pool: PgPool) {
    let (org, user, service, p) = setup(&pool).await;
    let future = record::get(&service, p.clone(), "2026-10".into())
        .await
        .unwrap();
    assert_eq!(
        record::get(&service, p.clone(), "9998-12".into())
            .await
            .unwrap()["state"],
        "not_started"
    );
    // November 1 is Sunday: first business day is November 2, through local midnight.
    assert_eq!(future["due"], "2026-11-02T15:00:00Z");
    let missing = record::get(&service, p.clone(), "2026-09".into())
        .await
        .unwrap();
    assert_eq!(missing["state"], "overdue");
    assert!(missing["started_at"].is_null());
    assert_eq!(
        record::complete(
            &service,
            p.clone(),
            "2026-09".into(),
            "overdue-not-started".into(),
            None
        )
        .await
        .unwrap_err()
        .code,
        "review_not_started"
    );
    let started = record::start(
        &service,
        p.clone(),
        "2026-09".into(),
        "overdue-review-start".into(),
    )
    .await
    .unwrap();
    assert_eq!(started["state"], "overdue");
    assert_eq!(started["due"], "2026-10-01T15:00:00Z");
    assert_eq!(
        started["flags_seen"]["rules"]["access_log_review.due_business_days"],
        1
    );
    let version: Value = sqlx::query_scalar("SELECT decision_snapshot->'access_log_review.due_business_days' FROM audit_events WHERE org_id=$1 AND action='access_log_review.start'")
        .bind(org.as_uuid()).fetch_one(&pool).await.unwrap();
    assert!(!version.is_null());
    sqlx::query("INSERT INTO tenant_setting_overrides(org_id,key,value,set_by,reason_code,effective_from) VALUES($1,'access_log_review.due_business_days','10',$2,'POLICY_REVIEW',clock_timestamp())")
        .bind(org.as_uuid()).bind(user.as_uuid()).execute(&pool).await.unwrap();
    for key in ["overdue-review-start", "overdue-review-fresh"] {
        let replay = record::start(&service, p.clone(), "2026-09".into(), key.into())
            .await
            .unwrap();
        assert_eq!(replay["state"], "overdue");
        assert_eq!(replay["due"], started["due"]);
    }
    let view = record::get(&service, p.clone(), "2026-09".into())
        .await
        .unwrap();
    assert_eq!(view["state"], "overdue");
    assert_eq!(view["due"], started["due"]);
    append(
        &pool,
        org,
        user,
        "2026-09",
        "access_log_review.complete",
        json!({}),
    )
    .await;
    assert_eq!(
        record::get(&service, p, "2026-09".into()).await.unwrap()["state"],
        "complete"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn finding_deadline_can_make_an_ontime_review_overdue(pool: PgPool) {
    let (org, user, service, p) = setup(&pool).await;
    append(&pool, org, user, "2026-09", "access_log_review.start", json!({"period":{"from":"2026-08-31T15:00:00Z","to":"2026-09-30T15:00:00Z","time_zone":"Asia/Seoul"},"due":"9998-12-31T00:00:00Z"})).await;
    assert_eq!(
        record::get(&service, p.clone(), "2026-09".into())
            .await
            .unwrap()["state"],
        "open"
    );
    let id = uuid::Uuid::new_v4();
    append(&pool, org, user, "2026-09", "access_log_review.finding", json!({"event_id":id,"disposition":"action_required","outcome":null,"reason_due":"2000-01-01T00:00:00Z","follow_up":{"kind":"none","closed":true}})).await;
    assert_eq!(
        record::get(&service, p.clone(), "2026-09".into())
            .await
            .unwrap()["state"],
        "overdue"
    );
    append(&pool, org, user, "2026-09", "access_log_review.finding", json!({"event_id":id,"disposition":"confirmed","outcome":"justified","reason_due":"2000-01-01T00:00:00Z","follow_up":{"kind":"none","closed":true}})).await;
    assert_eq!(
        record::get(&service, p, "2026-09".into()).await.unwrap()["state"],
        "open"
    );
}
