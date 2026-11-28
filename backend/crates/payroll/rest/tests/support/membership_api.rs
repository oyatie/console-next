// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

pub(super) const MEMBERS: &str = "/api/v1/payroll/pay-group-memberships";

pub(super) async fn assign(
    service: &axum::Router,
    token: &str,
    employee: Uuid,
    target: Uuid,
    source: Option<Uuid>,
    date: &str,
) -> JsonResponse {
    let body = json!({"pay_group_id":target,"employee_id":employee,"expected_pay_group_id":source,"effective_from":date});
    send(service, token, &body, &Uuid::new_v4().to_string()).await
}

pub(super) async fn send(
    service: &axum::Router,
    token: &str,
    body: &Value,
    key: &str,
) -> JsonResponse {
    let request = Request::builder()
        .uri(MEMBERS)
        .method("POST")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::CONTENT_TYPE, "application/json")
        .header("Idempotency-Key", key)
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = service.clone().oneshot(request).await.unwrap();
    JsonResponse {
        status: response.status(),
        json: serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
            .unwrap(),
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn membership_later_hire_repairs_regular_preview_and_preserves_dated_moves(pool: PgPool) {
    let (service, token, a, actor, _) = setup(&pool).await;
    let le = group_entity(&pool, a).await;
    let site = workplace(&pool, le).await;
    let original = employee(&pool, Some((le, site)), None).await;
    let store = PgPayrollStore::new(runtime_role_pool(&pool).await);
    let mut second = pay_groups_api::input(le);
    second["name"] = json!("Hourly");
    let b = store
        .create_pay_group(OrgId::one(), actor, serde_json::from_value(second).unwrap())
        .await
        .unwrap()
        .id;
    let first = assign(&service, &token, original, a, None, "2020-01-01").await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.json);
    assert_eq!(
        get(service.clone(), &uri(a, "REGULAR"), &token)
            .await
            .status,
        StatusCode::OK
    );
    let later = employee(&pool, Some((le, site)), None).await;
    let blocked = get(service.clone(), &uri(a, "REGULAR"), &token).await;
    assert_eq!(
        (blocked.status, blocked.json["error"]["code"].as_str()),
        (StatusCode::CONFLICT, Some("pay_group_roster_ambiguous"))
    );
    let date = "2020-02-01";
    let candidates = get(
        service.clone(),
        &format!("{MEMBERS}?pay_group_id={b}&effective_from={date}&q=Employee"),
        &token,
    )
    .await;
    assert_eq!(candidates.status, StatusCode::OK, "{}", candidates.json);
    assert!(
        candidates
            .json
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["employee_id"] == json!(later) && p["current_pay_group_id"].is_null())
    );
    assert_eq!(
        assign(&service, &token, later, b, None, date).await.status,
        StatusCode::OK
    );
    let run = create(
        service.clone(),
        &token,
        b,
        "REGULAR",
        &Uuid::new_v4().to_string(),
    )
    .await;
    assert_eq!(run.status, StatusCode::CREATED, "{}", run.json);
    assert_eq!(
        roster(
            &pool,
            serde_json::from_value(run.json["id"].clone()).unwrap()
        )
        .await[0]
            .0,
        Some(later)
    );
    assert_eq!(
        assign(&service, &token, later, a, None, "2030-01-01")
            .await
            .status,
        StatusCode::CONFLICT
    );
    assert_eq!(
        assign(&service, &token, later, a, Some(b), "2030-01-01")
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(
        assign(&service, &token, later, a, Some(b), "2025-01-01")
            .await
            .status,
        StatusCode::OK
    );
    let rows: Vec<(Uuid,String,Option<String>)>=sqlx::query_as("SELECT pay_group_id,effective_from::text,effective_to_exclusive::text FROM employee_pay_group_assignments WHERE employee_id=$1 AND superseded_at IS NULL ORDER BY effective_from")
        .bind(later).fetch_all(&pool).await.unwrap(); // rls-arming: ok owner verifies exact historical intervals
    assert_eq!(
        rows,
        vec![
            (b, date.into(), Some("2025-01-01".into())),
            (a, "2025-01-01".into(), Some("2030-01-01".into())),
            (a, "2030-01-01".into(), None)
        ]
    );
    let outside = pay_groups_api::entity(&pool, OrgId::one()).await;
    let foreign = employee(
        &pool,
        Some((outside, workplace(&pool, outside).await)),
        None,
    )
    .await;
    assert_eq!(
        assign(&service, &token, foreign, b, None, date)
            .await
            .status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        assign(&service, &token, Uuid::new_v4(), b, None, date)
            .await
            .status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn membership_refuses_source_freeze_and_closed_destination_without_partial_update(
    pool: PgPool,
) {
    let (service, token, a, actor, _) = setup(&pool).await;
    let le = group_entity(&pool, a).await;
    let person = employee(&pool, Some((le, workplace(&pool, le).await)), None).await;
    let mut second = pay_groups_api::input(le);
    second["name"] = json!("Hourly");
    let b = PgPayrollStore::new(runtime_role_pool(&pool).await)
        .create_pay_group(OrgId::one(), actor, serde_json::from_value(second).unwrap())
        .await
        .unwrap()
        .id;
    assert_eq!(
        assign(&service, &token, person, a, None, "2020-01-01")
            .await
            .status,
        StatusCode::OK
    );
    // rls-arming: ok owner seeds one scoped freeze and one already closed month.
    sqlx::query("INSERT INTO period_locks(org_id,domain,period_start,period_end,reason_code,locked_by,pay_group_id) VALUES($1,'payroll','2024-01-01','2024-01-31','MONTHLY_PAYROLL_CLOSE',$2,$3)")
        .bind(OrgId::one().as_uuid()).bind(actor.as_uuid()).bind(a).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO payroll_draft_runs(org_id,pay_group_id,kind,attribution_month,pay_date,period_start,period_end,variable_period_start,variable_period_end,source_label,status)
        VALUES($1,$2,'REGULAR','2025-02-01','2025-02-28','2025-02-01','2025-02-28','2025-02-01','2025-02-28','frozen-membership-proof','ATTENDANCE_CLOSED')")
        .bind(OrgId::one().as_uuid()).bind(b).execute(&pool).await.unwrap();
    for date in ["2024-01-15", "2025-02-10"] {
        let refused = assign(&service, &token, person, b, Some(a), date).await;
        assert_eq!(
            (refused.status, refused.json["error"]["code"].as_str()),
            (StatusCode::CONFLICT, Some("pay_group_membership_frozen"))
        );
    }
    assert_eq!(
        assign(&service, &token, person, b, Some(a), "2025-03-01")
            .await
            .status,
        StatusCode::OK
    );
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM employee_pay_group_assignments WHERE employee_id=$1",
    )
    .bind(person)
    .fetch_one(&pool)
    .await
    .unwrap(); // rls-arming: ok owner verifies atomic refusals
    assert_eq!(count, 2);
}
