// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{completion::*, *};
use console_platform_test_support::soft_passkey::SoftKey;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn completion_checks_the_second_frozen_chunk(pool: PgPool) {
    let (org, user, service, p) = setup(&pool).await;
    sqlx::query("INSERT INTO audit_events(org_id,actor,action,target_type,target_id,trace_id,span_id,created_at,occurred_at,after_snap) SELECT $1,$2,'employee.rrn_reveal','employee','test',repeat('a',32),repeat('b',16),'2026-09-01T02:00:00Z'::timestamptz+n*interval '1 millisecond','2026-09-01T02:00:00Z','{\"self_read\":false,\"subject_count\":0}' FROM generate_series(1,201) n")
        .bind(org.as_uuid()).bind(user.as_uuid()).execute(&pool).await.unwrap();
    record::start(
        &service,
        p.clone(),
        "2026-09".into(),
        "second-chunk-start".into(),
    )
    .await
    .unwrap();
    let ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM audit_events WHERE org_id=$1 AND action='employee.rrn_reveal' ORDER BY created_at,id")
        .bind(org.as_uuid()).fetch_all(&pool).await.unwrap();
    for id in &ids[..200] {
        append(&pool, org, user, "2026-09", "access_log_review.finding", json!({"event_id":id,"disposition":"confirmed","outcome":"justified","follow_up":{"kind":"none","closed":true}})).await;
    }
    let error = record::complete(
        &service,
        p,
        "2026-09".into(),
        "second-chunk-complete".into(),
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "review_incomplete");
    assert_eq!(
        error.details.as_deref(),
        Some(&json!({"open_event_ids":[ids[200]]}))
    );
    assert_eq!(refused_count(&pool, org, "review_incomplete").await, 1);
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='access_log_review.complete'",
    )
    .bind(org.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn completion_requires_each_summary_and_counts_latest_summary_findings(pool: PgPool) {
    let (org, user, service, p) = setup(&pool).await;
    let mut ids = Vec::new();
    for occurred in ["2026-09-01T12:00:00Z", "2026-09-02T12:00:00Z"] {
        ids.push(event(&pool, org, user, "employee.read", occurred, json!({})).await);
    }
    record::start(
        &service,
        p.clone(),
        "2026-09".into(),
        "summary-gate-start".into(),
    )
    .await
    .unwrap();
    let summaries: Value = sqlx::query_scalar("SELECT after_snap#>'{evidence,summaries}' FROM audit_events WHERE org_id=$1 AND action='access_log_review.start'")
        .bind(org.as_uuid()).fetch_one(&pool).await.unwrap();
    assert_eq!(summaries.as_array().unwrap().len(), 2);
    for id in ids {
        append(&pool, org, user, "2026-09", "access_log_review.finding", json!({"event_id":id,"disposition":"confirmed","outcome":"justified","follow_up":{"kind":"none","closed":true}})).await;
    }
    let targets: Vec<Value> = summaries
        .as_array()
        .unwrap()
        .iter()
        .map(|s| json!({"actor":s["actor"],"day":s["day"],"flag":s["flag"]}))
        .collect();
    for (n, target) in targets.iter().enumerate() {
        let error = record::complete(
            &service,
            p.clone(),
            "2026-09".into(),
            "summary-gate-complete".into(),
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "review_incomplete");
        assert_eq!(
            error.details.as_deref(),
            Some(&json!({"open_event_ids":[],"open_summaries":targets[n..]}))
        );
        // An older unresolved finding must be superseded independently for each summary.
        append(&pool, org, user, "2026-09", "access_log_review.finding", json!({"summary":target,"disposition":"action_required","outcome":null,"follow_up":{"kind":"retraining","closed":false}})).await;
        assert_eq!(
            record::complete(
                &service,
                p.clone(),
                "2026-09".into(),
                "summary-gate-complete".into(),
                None
            )
            .await
            .unwrap_err()
            .code,
            "review_incomplete"
        );
        append(&pool, org, user, "2026-09", "access_log_review.finding", json!({"summary":target,"disposition":"action_required","outcome":"excessive","follow_up":{"kind":"retraining","closed":true}})).await;
    }
    let view = record::get(&service, p.clone(), "2026-09".into())
        .await
        .unwrap();
    assert_eq!(view["findings"].as_array().unwrap().len(), 4);
    assert_eq!(view["follow_up"], json!({"open":0,"total":2}));
    let mut soft = SoftKey::enroll(&pool, org, user).await;
    let step = serde_json::from_value(soft.step_up(&pool).await).unwrap();
    let complete = record::complete(
        &service,
        p,
        "2026-09".into(),
        "summary-gate-complete".into(),
        Some(step),
    )
    .await
    .unwrap();
    assert_eq!(complete["state"], "complete");
    let evidence: Value = sqlx::query_scalar("SELECT after_snap FROM audit_events WHERE org_id=$1 AND action='access_log_review.complete'")
        .bind(org.as_uuid()).fetch_one(&pool).await.unwrap();
    assert_eq!(
        evidence,
        json!({"findings_total":4,"by_outcome":{"justified":2,"excessive":2},"follow_ups_open":0})
    );
    assert_eq!(refused_count(&pool, org, "review_incomplete").await, 4);
}
