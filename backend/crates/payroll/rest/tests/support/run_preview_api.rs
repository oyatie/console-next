// SPDX-License-Identifier: LicenseRef-Proprietary
use super::super::*;

const PREVIEW: &str = "/api/v1/payroll/runs/preview";

pub(super) async fn setup(pool: &PgPool) -> (axum::Router, String, Uuid, UserId, Uuid) {
    let org = OrgId::one();
    let actor = UserId::new();
    seed_user(pool, actor, *org.as_uuid(), "SUPER_ADMIN").await;
    // rls-arming: ok owner prepares an operating tenant for operational run tests.
    sqlx::query("UPDATE tenant_phase SET phase='OPERATING' WHERE org_id=$1")
        .bind(org.as_uuid())
        .execute(pool)
        .await
        .unwrap();
    let entity = pay_groups_api::entity(pool, org).await;
    pay_view::grant_manage(pool, org, actor, Some(entity)).await;
    let clearance = pay_view::grant_sensitive(pool, org, actor, Some(entity), "edit").await;
    let group = PgPayrollStore::new(runtime_role_pool(pool).await)
        .create_pay_group(
            org,
            actor,
            serde_json::from_value(pay_groups_api::input(entity)).unwrap(),
        )
        .await
        .unwrap();
    let keys = keys();
    let token = bearer(pool, &keys, actor, org, "SUPER_ADMIN").await;
    (
        app(runtime_role_pool(pool).await, &keys),
        token,
        group.id,
        actor,
        clearance,
    )
}

pub(super) fn uri(group: Uuid, kind: &str) -> String {
    format!("{PREVIEW}?pay_group_id={group}&kind={kind}")
}

pub(super) fn refusal(response: JsonResponse, status: StatusCode, code: &str) {
    assert_eq!(response.status, status, "{}", response.json);
    assert_eq!(response.json["error"]["code"], code);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn preview_derives_regular_without_writing_a_run(pool: PgPool) {
    let (service, token, group, _, _) = setup(&pool).await;
    for kind in ["REGULAR"] {
        let response = get(service.clone(), &uri(group, kind), &token).await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.json);
        assert_eq!(response.json["pay_group_id"], json!(group));
        assert_eq!(response.json["kind"], kind);
        assert!(response.json["legal_entity_id"].is_string());
        assert_eq!(
            response.json["attribution_month"].as_str().unwrap().len(),
            7
        );
        for field in [
            "pay_date",
            "period_start",
            "period_end",
            "variable_period_start",
            "variable_period_end",
        ] {
            assert_eq!(response.json[field].as_str().unwrap().len(), 10, "{field}");
        }
        assert_eq!(response.json["pay_date_clamped"], false);
        let repeated = get(service.clone(), &uri(group, kind), &token).await;
        assert_eq!(response.json, repeated.json);
    }
    // rls-arming: ok owner observes that previews commit no draft or command reservation.
    let count: i64 = sqlx::query_scalar("SELECT (SELECT count(*) FROM payroll_draft_runs)+(SELECT count(*) FROM api_idempotency_keys)")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(count, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn preview_selects_first_gap_per_group_and_ignores_void(pool: PgPool) {
    let (service, token, group, _, _) = setup(&pool).await;
    // rls-arming: ok owner seeds occupied months; all preview reads use console_rt.
    sqlx::query("INSERT INTO payroll_draft_runs(org_id,pay_group_id,kind,attribution_month,pay_date,period_start,period_end,variable_period_start,variable_period_end,source_label) SELECT $1,$2,'REGULAR',d,d,d,d,d,d,'occupied-'||n FROM generate_series(0,2) n CROSS JOIN LATERAL (SELECT (date_trunc('month',entity_today())+n*interval '1 month')::date d) dates WHERE n<>1")
        .bind(OrgId::one().as_uuid()).bind(group).execute(&pool).await.unwrap();
    let regular = get(service.clone(), &uri(group, "REGULAR"), &token).await;
    assert_eq!(regular.status, StatusCode::OK, "{}", regular.json);
    // rls-arming: ok owner independently computes the next calendar month for this fixture.
    let expected: String =
        sqlx::query_scalar("SELECT to_char(entity_today()+interval '1 month','YYYY-MM')")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(regular.json["attribution_month"], expected);
    let (other_service, other_token, other_group, _, _) = setup(&pool).await;
    let other = get(other_service, &uri(other_group, "REGULAR"), &other_token).await;
    assert_eq!(other.status, StatusCode::OK, "{}", other.json);
    assert!(other.json["attribution_month"].as_str().unwrap() < expected.as_str());
    // rls-arming: ok owner voids occupied rows, freeing their attribution month.
    sqlx::query("UPDATE payroll_draft_runs SET status='VOID'")
        .execute(&pool)
        .await
        .unwrap();
    let voided = get(service, &uri(group, "REGULAR"), &token).await;
    assert_eq!(
        voided.json["attribution_month"],
        other.json["attribution_month"]
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn preview_rechecks_group_and_sensitive_edit_and_validates_query(pool: PgPool) {
    let (service, token, group, actor, clearance) = setup(&pool).await;
    assert_eq!(
        get_unauthenticated(service.clone(), &uri(group, "REGULAR")).await,
        StatusCode::UNAUTHORIZED
    );
    for query in [
        String::new(),
        format!("?pay_group_id={group}"),
        format!("?pay_group_id={group}&kind=BONUS"),
        format!("?pay_group_id={group}&kind=REGULAR&pay_date=2026-12-01"),
    ] {
        refusal(
            get(service.clone(), &format!("{PREVIEW}{query}"), &token).await,
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation",
        );
    }
    // rls-arming: ok owner revokes sensitive edit while retaining the same bearer.
    sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=granted_by WHERE id=$1")
        .bind(clearance).execute(&pool).await.unwrap();
    for denied_group in [group, Uuid::new_v4()] {
        refusal(
            get(service.clone(), &uri(denied_group, "REGULAR"), &token).await,
            StatusCode::FORBIDDEN,
            "forbidden",
        );
    }
    pay_view::grant_sensitive(&pool, OrgId::one(), actor, None, "view").await;
    refusal(
        get(service.clone(), &uri(group, "REGULAR"), &token).await,
        StatusCode::FORBIDDEN,
        "forbidden",
    );
    pay_view::grant_sensitive(&pool, OrgId::one(), actor, None, "edit").await;
    // rls-arming: ok owner revokes pay:edit while keeping sensitive:edit.
    sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=granted_by WHERE account_id=$1 AND role_id IN (SELECT role_id FROM access_role_lines WHERE domain='pay')")
        .bind(actor.as_uuid()).execute(&pool).await.unwrap();
    pay_view::grant_view(&pool, OrgId::one(), actor, None).await;
    refusal(
        get(service.clone(), &uri(group, "REGULAR"), &token).await,
        StatusCode::FORBIDDEN,
        "forbidden",
    );
    let foreign = OrgId::from_uuid(Uuid::new_v4());
    let reader = seed_org_and_super_admin(&pool, *foreign.as_uuid(), "preview-foreign").await;
    pay_view::grant_manage(&pool, foreign, reader, None).await;
    let keys = keys();
    let token = bearer(&pool, &keys, reader, foreign, "SUPER_ADMIN").await;
    refusal(
        get(
            app(runtime_role_pool(&pool).await, &keys),
            &uri(group, "REGULAR"),
            &token,
        )
        .await,
        StatusCode::FORBIDDEN,
        "forbidden",
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn missing_holiday_year_refuses_preview(pool: PgPool) {
    let (service, token, group, _, _) = setup(&pool).await;
    // rls-arming: ok owner simulates a missing operator-loaded holiday register.
    sqlx::query("DELETE FROM attendance_public_holidays")
        .execute(&pool)
        .await
        .unwrap();
    refusal(
        get(service, &uri(group, "REGULAR"), &token).await,
        StatusCode::SERVICE_UNAVAILABLE,
        "holiday_calendar_missing",
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn referenced_weekend_and_holiday_date_each_adjust_the_pay_date(pool: PgPool) {
    let (service, token, group, _, _) = setup(&pool).await;
    let initial = get(service.clone(), &uri(group, "REGULAR"), &token).await;
    let first = initial.json["pay_date"].as_str().unwrap();
    // rls-arming: ok owner mutates reference rows; the request still reads as console_rt.
    sqlx::query("UPDATE access_log_review_calendar SET weekend_isodays=ARRAY[extract(isodow FROM $1::text::date)::smallint]")
        .bind(first).execute(&pool).await.unwrap();
    let weekend = get(service.clone(), &uri(group, "REGULAR"), &token).await;
    let second = weekend.json["pay_date"].as_str().unwrap();
    assert!(second < first, "PREVIOUS must honor the referenced weekend");
    sqlx::query("INSERT INTO attendance_public_holidays(holiday_date,name,kind,basis,edition) VALUES ($1::text::date,'테스트 휴일','NATIONAL','테스트 근거','test')")
        .bind(second).execute(&pool).await.unwrap();
    let holiday = get(service, &uri(group, "REGULAR"), &token).await;
    assert!(
        holiday.json["pay_date"].as_str().unwrap() < second,
        "PREVIOUS must honor the exact referenced holiday date"
    );
}
