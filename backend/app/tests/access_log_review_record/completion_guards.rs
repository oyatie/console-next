// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{completion::*, guards::grant, *};
use console_platform_access::Refusal;
use console_platform_test_support::soft_passkey::SoftKey;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn malformed_period_is_invalid_on_projection_and_completion(pool: PgPool) {
    let (org, _, service, p) = setup(&pool).await;
    for (n, period) in ["2026-9", "2026-13", "invalid"].into_iter().enumerate() {
        assert_eq!(
            record::get(&service, p.clone(), period.into())
                .await
                .unwrap_err()
                .code,
            "period_invalid"
        );
        assert_eq!(
            record::complete(
                &service,
                p.clone(),
                period.into(),
                format!("invalid-period-completion-{n}"),
                None
            )
            .await
            .unwrap_err()
            .code,
            "period_invalid"
        );
    }
    assert_eq!(refused_count(&pool, org, "period_invalid").await, 3);
    let written: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id=$1 AND action IN ('access_log_review.finding','access_log_review.complete')")
        .bind(org.as_uuid()).fetch_one(&pool).await.unwrap();
    assert_eq!(written, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn projection_and_completion_reload_cedar_and_keep_other_tenants_out(pool: PgPool) {
    let (org, _, service, p) = setup(&pool).await;
    assert_eq!(
        record::complete(
            &service,
            p.clone(),
            "2026-09".into(),
            "missing-review-key".into(),
            None
        )
        .await
        .unwrap_err()
        .code,
        "review_not_started"
    );
    assert_eq!(refused_count(&pool, org, "review_not_started").await, 1);
    record::start(
        &service,
        p.clone(),
        "2026-09".into(),
        "isolated-start-key".into(),
    )
    .await
    .unwrap();
    let (other, other_user, _, other_p) = setup(&pool).await;
    append(
        &pool,
        other,
        other_user,
        "2026-09",
        "access_log_review.finding",
        json!({"event_id":Uuid::new_v4(),"note":"foreign-secret"}),
    )
    .await;
    assert_eq!(
        record::get(&service, other_p.clone(), "2026-09".into())
            .await
            .unwrap()["state"],
        "not_started"
    );
    assert_eq!(
        record::complete(
            &service,
            other_p,
            "2026-09".into(),
            "other-complete-key".into(),
            None
        )
        .await
        .unwrap_err()
        .code,
        "review_not_started"
    );
    let review = record::get(&service, p.clone(), "2026-09".into())
        .await
        .unwrap();
    assert!(!review.to_string().contains("foreign-secret"));
    let user = console_platform_test_support::seed_active_user(
        &pool,
        *org.as_uuid(),
        "MEMBER",
        "review-reader",
    )
    .await;
    let p = principal(org, user);
    assert_eq!(
        record::get(&service, p.clone(), "2026-09".into())
            .await
            .unwrap_err()
            .code,
        "access_denied"
    );
    assert_eq!(
        record::complete(
            &service,
            p.clone(),
            "2026-09".into(),
            "denied-complete-key".into(),
            None
        )
        .await
        .unwrap_err()
        .code,
        "access_denied"
    );
    let entity = Uuid::new_v4();
    sqlx::query("INSERT INTO legal_entities(org_id,id,needs_confirmation,created_change_mode) VALUES($1,$2,true,'MIGRATION')").bind(org.as_uuid()).bind(entity).execute(&pool).await.unwrap();
    grant(&pool, org, user, &["view", "approve"], Some(entity)).await;
    assert_eq!(
        record::get(&service, p.clone(), "2026-09".into())
            .await
            .unwrap_err()
            .code,
        "scope_tenant_wide_only"
    );
    assert_eq!(
        record::complete(
            &service,
            p.clone(),
            "2026-09".into(),
            "scoped-complete-key".into(),
            None
        )
        .await
        .unwrap_err()
        .code,
        "scope_tenant_wide_only"
    );
    grant(&pool, org, user, &["view"], None).await;
    assert_eq!(
        record::get(&service, p.clone(), "2026-09".into())
            .await
            .unwrap()["state"],
        "open"
    );
    assert_eq!(
        record::complete(
            &service,
            p,
            "2026-09".into(),
            "reader-complete-key".into(),
            None
        )
        .await
        .unwrap_err()
        .code,
        "scope_tenant_wide_only"
    );
    assert_eq!(refused_count(&pool, org, "access_denied").await, 1);
    assert_eq!(refused_count(&pool, org, "scope_tenant_wide_only").await, 2);
    let writes: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id=$1 AND action IN ('access_log_review.finding','access_log_review.complete')").bind(org.as_uuid()).fetch_one(&pool).await.unwrap();
    assert_eq!(writes, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn completion_refuses_expired_or_wrong_user_step_up_and_rolls_back_audit_failure(
    pool: PgPool,
) {
    let (org, user, service, p) = setup(&pool).await;
    record::start(
        &service,
        p.clone(),
        "2026-09".into(),
        "stepup-start-key-1".into(),
    )
    .await
    .unwrap();
    let mut soft = SoftKey::enroll(&pool, org, user).await;
    let expired = soft.step_up(&pool).await;
    sqlx::query(
        "UPDATE auth_webauthn_ceremonies SET created_at=now()-interval '2 seconds',expires_at=now()-interval '1 second' WHERE id=$1",
    )
    .bind(Uuid::parse_str(expired["ceremony_id"].as_str().unwrap()).unwrap())
    .execute(&pool)
    .await
    .unwrap();
    let other = console_platform_test_support::seed_active_user(
        &pool,
        *org.as_uuid(),
        "MEMBER",
        "wrong-stepup",
    )
    .await;
    let mut other_key = SoftKey::enroll(&pool, org, other).await;
    for assertion in [expired, other_key.step_up(&pool).await] {
        let error = record::complete(
            &service,
            p.clone(),
            "2026-09".into(),
            "stepup-complete-key".into(),
            Some(serde_json::from_value(assertion).unwrap()),
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind, Refusal::StepUpFailed);
        assert_eq!(error.code, "unauthorized");
    }
    assert_eq!(refused_count(&pool, org, "unauthorized").await, 2);
    sqlx::raw_sql("CREATE FUNCTION reject_complete_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='access_log_review.complete' THEN RAISE EXCEPTION 'test write failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_complete_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_complete_audit()")
        .execute(&pool).await.unwrap();
    let step = serde_json::from_value(soft.step_up(&pool).await).unwrap();
    assert_eq!(
        record::complete(
            &service,
            p.clone(),
            "2026-09".into(),
            "stepup-complete-key".into(),
            Some(step)
        )
        .await
        .unwrap_err()
        .kind,
        Refusal::Internal
    );
    assert_eq!(
        record::get(&service, p.clone(), "2026-09".into())
            .await
            .unwrap()["state"],
        "open"
    );
    let reservations: i64 = sqlx::query_scalar("SELECT count(*) FROM api_idempotency_keys WHERE org_id=$1 AND operation='access_log_review.complete'").bind(org.as_uuid()).fetch_one(&pool).await.unwrap();
    assert_eq!(reservations, 0);
    sqlx::query("DROP TRIGGER reject_complete_audit ON audit_events")
        .execute(&pool)
        .await
        .unwrap();
    let step = serde_json::from_value(soft.step_up(&pool).await).unwrap();
    let complete = record::complete(
        &service,
        p,
        "2026-09".into(),
        "stepup-complete-key".into(),
        Some(step),
    )
    .await
    .unwrap();
    assert_eq!(complete["state"], "complete");
}
