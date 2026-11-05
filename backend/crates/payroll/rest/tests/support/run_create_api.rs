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
    // rls-arming: ok owner verifies the admission mode recorded by the writer.
    let mode: String = sqlx::query_scalar(
        "SELECT change_mode FROM audit_events WHERE action='payroll.run_create'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(mode, "GOVERNED");

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

async fn refuses_unsupported_kind(pool: PgPool, kind: &str) {
    let (service, token, group, _, _) = setup(&pool).await;
    refusal(
        get(service.clone(), &uri(group, kind), &token).await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "run_kind_unsupported",
    );
    refusal(
        create(service, &token, group, kind, &Uuid::new_v4().to_string()).await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "run_kind_unsupported",
    );
    // rls-arming: ok owner checks that refused kinds persist no run.
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM payroll_draft_runs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn off_cycle_requires_an_explicit_attribution_month(pool: PgPool) {
    refuses_unsupported_kind(pool, "OFF_CYCLE").await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn correction_requires_a_past_attribution_month(pool: PgPool) {
    refuses_unsupported_kind(pool, "CORRECTION").await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn exit_settlement_requires_a_person_and_exit_package(pool: PgPool) {
    refuses_unsupported_kind(pool, "EXIT_SETTLEMENT").await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn same_named_groups_create_independent_regular_runs(pool: PgPool) {
    let (service, token, group, actor, _) = setup(&pool).await;
    let entity = pay_groups_api::entity(&pool, OrgId::one()).await;
    pay_view::grant_manage(&pool, OrgId::one(), actor, Some(entity)).await;
    pay_view::grant_sensitive(&pool, OrgId::one(), actor, Some(entity), "edit").await;
    let other = PgPayrollStore::new(runtime_role_pool(&pool).await)
        .create_pay_group(
            OrgId::one(),
            actor,
            serde_json::from_value(pay_groups_api::input(entity)).unwrap(),
        )
        .await
        .unwrap();
    for group in [group, other.id] {
        let response = create(
            service.clone(),
            &token,
            group,
            "REGULAR",
            &Uuid::new_v4().to_string(),
        )
        .await;
        assert_eq!(response.status, StatusCode::CREATED, "{}", response.json);
        assert_eq!(response.json["source_label"], response.json["id"]);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn setup_tenant_cannot_create_a_run(pool: PgPool) {
    let (service, token, group, _, _) = setup(&pool).await;
    // rls-arming: ok owner changes tenant lifecycle; the request uses console_rt.
    sqlx::query("DELETE FROM tenant_phase WHERE org_id=$1")
        .bind(OrgId::one().as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO tenant_phase(org_id,phase) VALUES ($1,'SETUP') ON CONFLICT(org_id) DO UPDATE SET phase='SETUP'")
        .bind(OrgId::one().as_uuid()).execute(&pool).await.unwrap();
    let response = create(
        service,
        &token,
        group,
        "REGULAR",
        &Uuid::new_v4().to_string(),
    )
    .await;
    let expected = console_kernel_core::tenant_phase::admit_write(
        console_kernel_core::TenantPhase::Setup,
        console_kernel_core::WriteClass::Operational,
    )
    .unwrap_err();
    assert_eq!(response.json["error"]["message"], expected.message);
    refusal(response, StatusCode::CONFLICT, "phase_not_operating");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM payroll_draft_runs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}
