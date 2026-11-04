// SPDX-License-Identifier: LicenseRef-Proprietary
use super::super::*;
use super::run_preview_api::{refusal, setup, uri};

async fn create(
    service: axum::Router,
    token: &str,
    group: Uuid,
    kind: &str,
    key: &str,
) -> JsonResponse {
    let response = service
        .oneshot(
            Request::builder()
                .uri(PAYROLL_RUNS_PATH)
                .method("POST")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::CONTENT_TYPE, "application/json")
                .header("Idempotency-Key", key)
                .body(Body::from(
                    json!({"pay_group_id":group,"kind":kind}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    JsonResponse {
        status: response.status(),
        json: serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
            .unwrap_or_else(|_| json!({})),
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn create_uses_preview_snapshot_and_replays_the_original_summary(pool: PgPool) {
    let (service, token, group, actor, _) = setup(&pool).await;
    let preview = get(service.clone(), &uri(group, "REGULAR"), &token).await;
    let key = Uuid::new_v4().to_string();
    let created = create(service.clone(), &token, group, "REGULAR", &key).await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.json);
    for field in [
        "legal_entity_id",
        "pay_group_id",
        "kind",
        "attribution_month",
        "pay_date",
        "period_start",
        "period_end",
        "variable_period_start",
        "variable_period_end",
    ] {
        assert_eq!(created.json[field], preview.json[field], "{field}");
    }
    assert_eq!(created.json["status"], "BLOCKED_LEGAL_GATE");
    let replay = create(service.clone(), &token, group, "REGULAR", &key).await;
    assert_eq!(
        (replay.status, replay.json),
        (created.status, created.json.clone())
    );
    let changed = create(service.clone(), &token, group, "CORRECTION", &key).await;
    refusal(changed, StatusCode::CONFLICT, "idempotency_key_reused");
    pay_view::grant_view(&pool, OrgId::one(), actor, None).await;
    let listed = get(service, PAYROLL_RUNS_PATH, &token).await;
    assert_eq!(listed.status, StatusCode::OK, "{}", listed.json);
    assert_eq!(listed.json["items"], json!([created.json]));
    // rls-arming: ok owner verifies the command ledger and audit cardinality.
    let counts: (i64, i64, i64, Option<i16>) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM payroll_draft_runs),
                (SELECT count(*) FROM audit_events WHERE action='payroll.run_create'),
                (SELECT count(*) FROM command_outcomes WHERE command='POST /api/v1/payroll/runs'),
                (SELECT response_status FROM command_outcomes WHERE idempotency_key=$1)",
    )
    .bind(key)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(counts, (1, 1, 1, Some(201)));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn create_validates_body_and_rechecks_sensitive_edit(pool: PgPool) {
    let (service, token, group, _, clearance) = setup(&pool).await;
    let invalid = service
        .clone()
        .oneshot(
            Request::builder()
                .uri(PAYROLL_RUNS_PATH)
                .method("POST")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({"pay_group_id":group,"kind":"BONUS"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::UNPROCESSABLE_ENTITY);
    // rls-arming: ok owner revokes sensitive edit while retaining the same bearer.
    sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=granted_by WHERE id=$1")
        .bind(clearance).execute(&pool).await.unwrap();
    refusal(
        create(
            service,
            &token,
            group,
            "REGULAR",
            &Uuid::new_v4().to_string(),
        )
        .await,
        StatusCode::FORBIDDEN,
        "forbidden",
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn concurrent_regular_run_for_the_same_derived_month_is_coded(pool: PgPool) {
    let (service, token, group, _, _) = setup(&pool).await;
    // rls-arming: ok owner installs a test-only race barrier before requests run as console_rt.
    sqlx::query("CREATE FUNCTION payroll_run_test_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.attribution_month=DATE '2099-01-01'; RETURN NEW; END $$")
        .execute(&pool).await.unwrap();
    sqlx::query("CREATE TRIGGER payroll_run_test_barrier BEFORE INSERT ON payroll_draft_runs FOR EACH ROW EXECUTE FUNCTION payroll_run_test_barrier()")
        .execute(&pool).await.unwrap();
    let key_a = Uuid::new_v4().to_string();
    let key_b = Uuid::new_v4().to_string();
    let (a, b) = tokio::join!(
        create(service.clone(), &token, group, "REGULAR", &key_a),
        create(service, &token, group, "REGULAR", &key_b),
    );
    let (created, refused) = if a.status == StatusCode::CREATED {
        (a, b)
    } else {
        (b, a)
    };
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.json);
    refusal(refused, StatusCode::CONFLICT, "regular_run_exists");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM payroll_draft_runs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}
