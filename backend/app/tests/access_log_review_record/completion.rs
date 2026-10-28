// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_platform_access::{Refusal, StepUp};
use console_platform_test_support::soft_passkey::{SoftKey, passkey_service};
use uuid::Uuid;

pub(super) async fn append(
    pool: &PgPool,
    org: OrgId,
    user: UserId,
    period: &str,
    action: &str,
    snap: Value,
) -> Uuid {
    sqlx::query_scalar("INSERT INTO audit_events(org_id,actor,action,target_type,target_id,trace_id,span_id,occurred_at,after_snap) VALUES($1,$2,$3,'access_log_review',$4,repeat('a',32),repeat('b',16),clock_timestamp(),$5) RETURNING id")
        .bind(org.as_uuid()).bind(user.as_uuid()).bind(action).bind(format!("tenant:{period}")).bind(snap).fetch_one(pool).await.unwrap()
}

pub(super) async fn setup(pool: &PgPool) -> (OrgId, UserId, AccessService, Principal) {
    let org = OrgId::new();
    let user = seed_org_and_super_admin(pool, *org.as_uuid(), "completion").await;
    reviewer(pool, org, user).await;
    let service = AccessService::new(runtime_role_pool(pool).await, Some(passkey_service()));
    (org, user, service, principal(org, user))
}

pub(super) async fn refused_count(pool: &PgPool, org: OrgId, code: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='access_log_review.refused' AND outcome='DENIED' AND after_snap->>'code'=$2")
        .bind(org.as_uuid()).bind(code).fetch_one(pool).await.unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn projection_and_start_replays_show_latest_state_without_evidence_chunks(pool: PgPool) {
    let (org, user, service, p) = setup(&pool).await;
    let started = record::start(
        &service,
        p.clone(),
        "2026-09".into(),
        "projection-start-key".into(),
    )
    .await
    .unwrap();
    let event = Uuid::new_v4();
    append(&pool, org, user, "2026-09", "access_log_review.finding", json!({"event_id":event,"disposition":"action_required","outcome":null,"reason_due":"2000-01-01T00:00:00Z","follow_up":{"kind":"incident","ref":"incident-1","closed":false}})).await;
    let overdue = record::get(&service, p.clone(), "2026-09".into())
        .await
        .unwrap();
    assert_eq!(overdue["state"], "overdue");
    assert_eq!(overdue["findings"].as_array().unwrap().len(), 1);
    assert_eq!(overdue["follow_up"]["open"], 1);
    let subjects: Value = sqlx::query_scalar("SELECT after_snap->'subject_ids' FROM audit_events WHERE org_id=$1 AND action='access_log.review_read' AND after_snap->>'projection'='review'")
        .bind(org.as_uuid()).fetch_one(&pool).await.unwrap();
    assert_eq!(subjects, json!([user]));
    for key in ["evidence", "evidence_header", "chunk_ends"] {
        assert!(overdue["flags_seen"].get(key).is_none());
    }
    assert_eq!(
        overdue["flags_seen"]["rules"],
        started["flags_seen"]["rules"]
    );
    for key in ["projection-start-key", "projection-fresh-key"] {
        assert_eq!(
            record::start(&service, p.clone(), "2026-09".into(), key.into())
                .await
                .unwrap()["state"],
            "overdue"
        );
    }
    append(&pool, org, user, "2026-09", "access_log_review.finding", json!({"event_id":event,"disposition":"confirmed","outcome":"justified","reason_due":"2000-01-01T00:00:00Z","follow_up":{"kind":"none","ref":null,"closed":true}})).await;
    let open = record::get(&service, p.clone(), "2026-09".into())
        .await
        .unwrap();
    assert_eq!(open["state"], "open");
    assert_eq!(open["findings"].as_array().unwrap().len(), 1);
    assert_eq!(open["findings"][0]["decided_by"], json!(user));
    append(
        &pool,
        org,
        user,
        "2026-08",
        "access_log_review.complete",
        json!({}),
    )
    .await;
    assert_eq!(
        record::get(&service, p.clone(), "2026-09".into())
            .await
            .unwrap()["state"],
        "open"
    );
    append(
        &pool,
        org,
        user,
        "2026-09",
        "access_log_review.complete",
        json!({}),
    )
    .await;
    let done = record::get(&service, p.clone(), "2026-09".into())
        .await
        .unwrap();
    assert_eq!(done["state"], "complete");
    assert!(done["reviewed_at"].as_str().is_some());
    assert_eq!(
        record::start(
            &service,
            p.clone(),
            "2026-09".into(),
            "projection-start-key".into()
        )
        .await
        .unwrap()["state"],
        "complete"
    );
    assert_eq!(
        record::get(&service, p, "2026-07".into()).await.unwrap()["state"],
        "not_started"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn complete_requires_every_frozen_finding_and_closed_followups_then_real_step_up(
    pool: PgPool,
) {
    let (org, user, service, p) = setup(&pool).await;
    let event = event(
        &pool,
        org,
        user,
        "employee.rrn_reveal",
        "2026-09-01T02:00:00Z",
        json!({}),
    )
    .await;
    record::start(
        &service,
        p.clone(),
        "2026-09".into(),
        "completion-start-key".into(),
    )
    .await
    .unwrap();
    let mut soft = SoftKey::enroll(&pool, org, user).await;
    let assertion: StepUp = serde_json::from_value(soft.step_up(&pool).await).unwrap();
    let error = record::complete(
        &service,
        p.clone(),
        "2026-09".into(),
        "complete-review-key".into(),
        Some(assertion),
    )
    .await
    .unwrap_err();
    assert_eq!(error.kind, Refusal::Conflict);
    assert_eq!(error.code, "review_incomplete");
    assert_eq!(
        error.details.as_deref(),
        Some(&json!({"open_event_ids":[event]}))
    );
    for (outcome, kind, closed) in [
        (Value::Null, "none", true),
        (json!("excessive"), "retraining", false),
    ] {
        append(&pool, org, user, "2026-09", "access_log_review.finding", json!({"event_id":event,"disposition":"action_required","outcome":outcome,"follow_up":{"kind":kind,"ref":"followup-1","closed":closed}})).await;
        assert_eq!(
            record::complete(
                &service,
                p.clone(),
                "2026-09".into(),
                "complete-review-key".into(),
                None
            )
            .await
            .unwrap_err()
            .code,
            "review_incomplete"
        );
    }
    // A confirmed disposition still cannot close an outstanding required follow-up.
    append(&pool, org, user, "2026-09", "access_log_review.finding", json!({"event_id":event,"disposition":"confirmed","outcome":"justified","follow_up":{"kind":"retraining","ref":"followup-1","closed":false}})).await;
    assert_eq!(
        record::complete(
            &service,
            p.clone(),
            "2026-09".into(),
            "complete-review-key".into(),
            None
        )
        .await
        .unwrap_err()
        .code,
        "review_incomplete"
    );
    assert_eq!(refused_count(&pool, org, "review_incomplete").await, 4);
    let (findings, completions): (i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER(WHERE action='access_log_review.finding'),count(*) FILTER(WHERE action='access_log_review.complete') FROM audit_events WHERE org_id=$1",
    )
    .bind(org.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((findings, completions), (3, 0));
    append(&pool, org, user, "2026-09", "access_log_review.finding", json!({"event_id":event,"disposition":"action_required","outcome":"excessive","follow_up":{"kind":"retraining","ref":"followup-1","closed":true}})).await;
    assert_eq!(
        record::complete(
            &service,
            p.clone(),
            "2026-09".into(),
            "complete-review-key".into(),
            None
        )
        .await
        .unwrap_err()
        .code,
        "step_up_required"
    );
    assert_eq!(refused_count(&pool, org, "step_up_required").await, 1);
    let step = serde_json::from_value(soft.step_up(&pool).await).unwrap();
    let done = record::complete(
        &service,
        p.clone(),
        "2026-09".into(),
        "complete-review-key".into(),
        Some(step),
    )
    .await
    .unwrap();
    assert_eq!(done["state"], "complete");
    for key in ["complete-review-key", "complete-review-fresh"] {
        assert_eq!(
            record::complete(&service, p.clone(), "2026-09".into(), key.into(), None)
                .await
                .unwrap(),
            done
        );
    }
    let rows: Vec<Value> = sqlx::query_scalar("SELECT after_snap FROM audit_events WHERE org_id=$1 AND action='access_log_review.complete'").bind(org.as_uuid()).fetch_all(&pool).await.unwrap();
    assert_eq!(
        rows,
        [json!({"findings_total":1,"by_outcome":{"excessive":1},"follow_ups_open":0})]
    );
    assert_eq!(
        record::get(&service, p.clone(), "2026-09".into())
            .await
            .unwrap(),
        done
    );
    let mismatch = record::complete(
        &service,
        p,
        "2026-08".into(),
        "complete-review-key".into(),
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(mismatch.kind, Refusal::Conflict);
    assert_eq!(
        mismatch.message,
        console_platform_db::idempotency::IDEMPOTENCY_KEY_REUSED
    );
    assert_eq!(refused_count(&pool, org, "conflict").await, 1);
}
