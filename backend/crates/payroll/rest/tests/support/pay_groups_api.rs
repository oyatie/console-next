// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[path = "reference_rates_api.rs"]
mod reference_rates_api;

#[path = "nullable_pay_groups.rs"]
mod nullable_pay_groups;
#[path = "run_create_api.rs"]
mod run_create_api;
#[path = "run_preview_api.rs"]
mod run_preview_api;

#[path = "module_readiness.rs"]
mod module_readiness;

#[path = "pay_group_idempotency.rs"]
mod pay_group_idempotency;

const GROUPS: &str = "/api/v1/payroll/pay-groups";

pub(super) async fn entity(pool: &PgPool, org: OrgId) -> Uuid {
    // rls-arming: ok owner seeds prerequisites; HTTP requests use console_rt.
    sqlx::query_scalar("INSERT INTO legal_entities(org_id,id,needs_confirmation,created_change_mode) VALUES ($1,$2,true,'MIGRATION') RETURNING id")
        .bind(org.as_uuid()).bind(Uuid::new_v4()).fetch_one(pool).await.unwrap()
}

pub(super) fn input(entity: Uuid) -> Value {
    json!({"legal_entity_id":entity,"name":"모의상사 월급",
        "pay_date_rule":{"day":"LAST_DAY","month_offset":0,"non_business_day":"PREVIOUS"},
        "base_period":{"start_day":"FIRST","month_offset":0},
        "variable_period":{"start_day":16,"month_offset":-1},
        "proration":"CALENDAR_DAYS","channel":"ATTESTATION_ONLY",
        "sensitive":true,"pay_basis_allowed":["MONTHLY","HOURLY"]})
}

async fn post(service: axum::Router, token: &str, input: Value) -> JsonResponse {
    let request = Request::builder()
        .uri(GROUPS)
        .method("POST")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(input.to_string()))
        .unwrap();
    let response = service.oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    JsonResponse {
        status,
        json: serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({})),
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn explicit_pay_groups_round_trip_over_http_and_require_live_cedar(pool: PgPool) {
    let org = OrgId::one();
    let actor = UserId::new();
    seed_user(&pool, actor, *org.as_uuid(), "SUPER_ADMIN").await;
    let a = entity(&pool, org).await;
    let b = entity(&pool, org).await;
    let keys = keys();
    let token = bearer(&pool, &keys, actor, org, "SUPER_ADMIN").await;
    let service = app(runtime_role_pool(&pool).await, &keys);
    assert_eq!(
        get_unauthenticated(service.clone(), GROUPS).await,
        StatusCode::UNAUTHORIZED
    );
    for response in [
        get(service.clone(), GROUPS, &token).await,
        post(service.clone(), &token, input(a)).await,
    ] {
        assert_eq!(response.status, StatusCode::FORBIDDEN);
        assert_eq!(response.json["error"]["code"], "forbidden");
    }
    let grant = pay_view::grant_manage(&pool, org, actor, Some(a)).await;
    pay_view::grant_sensitive(&pool, org, actor, Some(a), "edit").await;
    for target in [b, Uuid::new_v4()] {
        let refused = post(service.clone(), &token, input(target)).await;
        assert_eq!(refused.status, StatusCode::FORBIDDEN);
        assert_eq!(refused.json["error"]["code"], "forbidden");
    }
    let expected = input(a);
    let created = post(service.clone(), &token, expected.clone()).await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.json);
    assert!(
        created.json["id"]
            .as_str()
            .and_then(|id| Uuid::parse_str(id).ok())
            .is_some()
    );
    let listed = get(service.clone(), GROUPS, &token).await;
    assert_eq!(listed.status, StatusCode::OK);
    assert_eq!(listed.json["legal_entities"], json!([{"id":a,"name":null}]));
    assert_eq!(listed.json["items"], json!([created.json]));
    let mut actual = listed.json["items"][0].clone();
    actual.as_object_mut().unwrap().remove("id");
    assert_eq!(actual, expected);
    // rls-arming: ok revoke the fixture between calls with the same bearer token.
    sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=granted_by WHERE id=$1")
        .bind(grant).execute(&pool).await.unwrap();
    let revoked = get(service.clone(), GROUPS, &token).await;
    assert_eq!(revoked.status, StatusCode::FORBIDDEN);
    assert_eq!(revoked.json["error"]["code"], "forbidden");
    pay_view::grant_view(&pool, org, actor, Some(a)).await;
    assert_eq!(
        get(service.clone(), GROUPS, &token).await.status,
        StatusCode::OK
    );
    assert_eq!(
        post(service, &token, input(a)).await.status,
        StatusCode::FORBIDDEN
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn pay_groups_http_refuses_missing_rules_invalid_input_and_cross_tenant_reads(pool: PgPool) {
    let org = OrgId::one();
    let actor = UserId::new();
    seed_user(&pool, actor, *org.as_uuid(), "MEMBER").await;
    let a = entity(&pool, org).await;
    pay_view::grant_manage(&pool, org, actor, None).await;
    pay_view::grant_sensitive(&pool, org, actor, None, "edit").await;
    let keys = keys();
    let token = bearer(&pool, &keys, actor, org, "MEMBER").await;
    let service = app(runtime_role_pool(&pool).await, &keys);
    for field in [
        "pay_date_rule",
        "base_period",
        "variable_period",
        "proration",
        "channel",
        "sensitive",
        "pay_basis_allowed",
    ] {
        let mut missing = input(a);
        missing.as_object_mut().unwrap().remove(field);
        let response = post(service.clone(), &token, missing).await;
        assert_eq!(
            response.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{field}: {}",
            response.json
        );
        assert_eq!(response.json["error"]["code"], "validation");
    }
    for (field, value) in [
        ("name", json!("")),
        ("pay_basis_allowed", json!([])),
        ("pay_basis_allowed", json!(["MONTHLY", "MONTHLY"])),
        (
            "pay_date_rule",
            json!({"day":32,"month_offset":0,"non_business_day":"NEXT"}),
        ),
    ] {
        let mut invalid = input(a);
        invalid[field] = value;
        let response = post(service.clone(), &token, invalid).await;
        assert_eq!(
            response.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{}",
            response.json
        );
        assert_eq!(response.json["error"]["code"], "validation");
    }
    for (field, value) in [
        ("sensitive", json!("false")),
        ("pay_basis_allowed", json!(["OTHER"])),
        ("proration", json!("free text")),
    ] {
        let mut invalid = input(a);
        invalid[field] = value;
        assert_eq!(
            post(service.clone(), &token, invalid).await.status,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    assert_eq!(
        get(service.clone(), GROUPS, &token).await.json["items"],
        json!([])
    );
    assert_eq!(
        post(service.clone(), &token, input(a)).await.status,
        StatusCode::CREATED
    );
    let foreign = OrgId::from_uuid(Uuid::new_v4());
    let reader = seed_org_and_super_admin(&pool, *foreign.as_uuid(), "pay-group-other-org").await;
    pay_view::grant_manage(&pool, foreign, reader, None).await;
    let foreign_token = bearer(&pool, &keys, reader, foreign, "SUPER_ADMIN").await;
    assert_eq!(
        get(service.clone(), GROUPS, &foreign_token).await.json["items"],
        json!([])
    );
    let refused = post(service, &foreign_token, input(a)).await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN);
    assert_eq!(refused.json["error"]["code"], "forbidden");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn sensitive_group_http_refuses_create_and_hides_rows_without_clearance(pool: PgPool) {
    let org = OrgId::one();
    let actor = UserId::new();
    seed_user(&pool, actor, *org.as_uuid(), "SUPER_ADMIN").await;
    let a = entity(&pool, org).await;
    pay_view::grant_manage(&pool, org, actor, None).await;
    let keys = keys();
    let token = bearer(&pool, &keys, actor, org, "SUPER_ADMIN").await;
    let service = app(runtime_role_pool(&pool).await, &keys);
    let denied = post(service.clone(), &token, input(a)).await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN);
    assert_eq!(denied.json["error"]["code"], "forbidden");
    assert_eq!(
        get(service.clone(), GROUPS, &token).await.json["items"],
        json!([])
    );
    let clearance = pay_view::grant_sensitive(&pool, org, actor, None, "edit").await;
    let created = post(service.clone(), &token, input(a)).await;
    assert_eq!(created.status, StatusCode::CREATED);
    assert_eq!(
        get(service.clone(), GROUPS, &token).await.json["items"],
        json!([created.json])
    );
    // rls-arming: ok remove live clearance while reusing the same HTTP bearer.
    sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=granted_by WHERE id=$1")
        .bind(clearance).execute(&pool).await.unwrap();
    let hidden = get(service.clone(), GROUPS, &token).await;
    assert_eq!(hidden.status, StatusCode::OK);
    assert_eq!(hidden.json["items"], json!([]));
    assert_eq!(hidden.json["legal_entities"], json!([{"id":a,"name":null}]));
    let denied = post(service, &token, input(a)).await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN);
    assert_eq!(denied.json["error"]["code"], "forbidden");
}
