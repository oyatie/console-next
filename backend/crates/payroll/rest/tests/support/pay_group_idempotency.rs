// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[path = "pay_group_completed_retry.rs"]
mod pay_group_completed_retry;

async fn fixture(pool: &PgPool) -> (axum::Router, String, Value, OrgId, UserId, Uuid) {
    let org = OrgId::new();
    let actor = seed_org_and_super_admin(pool, *org.as_uuid(), "pay-group-retry").await;
    let entity = entity(pool, org).await;
    let grant = pay_view::grant_manage(pool, org, actor, None).await;
    pay_view::grant_sensitive(pool, org, actor, None, "edit").await;
    let keys = keys();
    let token = bearer(pool, &keys, actor, org, "SUPER_ADMIN").await;
    let service = app(runtime_role_pool(pool).await, &keys);
    (service, token, input(entity), org, actor, grant)
}

async fn keyed(service: axum::Router, token: &str, input: Value, key: &str) -> JsonResponse {
    let response = service
        .oneshot(
            Request::builder()
                .uri(GROUPS)
                .method("POST")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::CONTENT_TYPE, "application/json")
                .header("Idempotency-Key", key)
                .body(Body::from(input.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    JsonResponse {
        status: response.status(),
        json: serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
            .unwrap(),
    }
}

async fn counts(pool: &PgPool, org: OrgId) -> (i64, i64, i64) {
    // rls-arming: ok owner inspects committed rows after requests run as console_rt.
    sqlx::query_as(
        "SELECT (SELECT count(*) FROM pay_groups WHERE org_id=$1),
                (SELECT count(*) FROM command_outcomes WHERE org_id=$1 AND command='POST /api/v1/payroll/pay-groups'),
                (SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='payroll.pay_group_create')",
    )
    .bind(org.as_uuid())
    .fetch_one(pool)
    .await
    .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn pay_group_retry_replays_concurrent_creates_once(pool: PgPool) {
    const LOCK_WAIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
    const CREATE_AND_RETRY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
    let (service, token, input, org, _, _) = fixture(&pool).await;
    let key = Uuid::new_v4().to_string();
    // Hold the INSERT until the retry has observed the admitted, unfinished command.
    let mut gate = pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE pay_groups IN SHARE MODE")
        .execute(&mut *gate)
        .await
        .unwrap();
    let blocker: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *gate)
        .await
        .unwrap();
    let first = keyed(service.clone(), &token, input.clone(), &key);
    let retry = async {
        tokio::time::timeout(LOCK_WAIT_TIMEOUT, async {
            loop {
                let blocked: bool = sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND relation='pay_groups'::regclass AND mode='RowExclusiveLock' AND NOT granted AND $1=ANY(pg_blocking_pids(pid)))",
                )
                .bind(blocker)
                .fetch_one(&pool)
                .await
                .unwrap();
                if blocked {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap_or_else(|_| {
            panic!("first pay-group create did not reach the held INSERT lock within {LOCK_WAIT_TIMEOUT:?}")
        });
        let state: (String, bool) = sqlx::query_as(
            "SELECT state,execution_token IS NOT NULL FROM command_outcomes WHERE org_id=$1 AND idempotency_key=$2",
        )
        .bind(org.as_uuid())
        .bind(&key)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(state, ("PROCESSING".into(), true));
        let retry = keyed(service.clone(), &token, input.clone(), &key).await;
        assert_eq!(retry.status, StatusCode::CONFLICT, "{}", retry.json);
        assert_eq!(retry.json["error"]["code"], "command_processing");
        assert_eq!(counts(&pool, org).await, (0, 1, 0));
        gate.rollback().await.unwrap();
    };
    let (created, ()) = tokio::time::timeout(CREATE_AND_RETRY_TIMEOUT, async {
        tokio::join!(first, retry)
    })
    .await
    .unwrap_or_else(|_| {
        panic!("concurrent create and retry did not settle within {CREATE_AND_RETRY_TIMEOUT:?}")
    });
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.json);
    let replay = keyed(service, &token, input, &key).await;
    assert_eq!(replay.status, StatusCode::CREATED, "{}", replay.json);
    assert_eq!(replay.json["id"], created.json["id"]);
    assert_eq!(replay.json, created.json);
    assert_eq!(counts(&pool, org).await, (1, 1, 1));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn pay_group_retry_rejects_every_changed_choice(pool: PgPool) {
    let (service, token, input, org, _, _) = fixture(&pool).await;
    let key = Uuid::new_v4().to_string();
    let created = keyed(service.clone(), &token, input.clone(), &key).await;
    assert_eq!(created.status, StatusCode::CREATED);
    let other_entity = entity(&pool, org).await;
    for (field, value) in [
        ("legal_entity_id", json!(other_entity)),
        ("name", json!("모의상사 시급")),
        (
            "pay_date_rule",
            json!({"day":25,"month_offset":1,"non_business_day":"NEXT"}),
        ),
        ("base_period", json!({"start_day":2,"month_offset":-1})),
        (
            "variable_period",
            json!({"start_day":"FIRST","month_offset":0}),
        ),
        ("proration", json!("SCHEDULED_WORKDAYS")),
        ("channel", json!("FILE_GENERIC")),
        ("sensitive", json!(false)),
        ("pay_basis_allowed", json!(["MONTHLY"])),
    ] {
        let mut changed = input.clone();
        changed[field] = value;
        let refused = keyed(service.clone(), &token, changed, &key).await;
        assert_eq!(
            refused.status,
            StatusCode::CONFLICT,
            "{field}: {}",
            refused.json
        );
        assert_eq!(refused.json["error"]["code"], "idempotency_key_reused");
        assert_eq!(counts(&pool, org).await, (1, 1, 1));
    }
    assert_eq!(keyed(service, &token, input, &key).await.json, created.json);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn pay_group_retry_keeps_refusals_settled_and_rechecks_revoked_access(pool: PgPool) {
    let (service, token, input, org, _, grant) = fixture(&pool).await;
    let key = Uuid::new_v4().to_string();
    let mut invalid = input.clone();
    invalid["name"] = json!("");
    assert_eq!(
        keyed(service.clone(), &token, invalid, &key).await.status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(counts(&pool, org).await, (0, 1, 0));
    let refused = keyed(service.clone(), &token, input.clone(), &key).await;
    assert_eq!(refused.status, StatusCode::CONFLICT);
    assert_eq!(refused.json["error"]["code"], "idempotency_key_reused");
    let key = Uuid::new_v4().to_string();
    let created = keyed(service.clone(), &token, input.clone(), &key).await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.json);
    assert_eq!(counts(&pool, org).await, (1, 2, 1));
    assert_eq!(
        keyed(service.clone(), &token, input.clone(), &key)
            .await
            .json,
        created.json
    );
    // rls-arming: ok owner revokes live access between requests with the same token.
    sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=granted_by WHERE id=$1")
        .bind(grant).execute(&pool).await.unwrap();
    let refused = keyed(service, &token, input, &key).await;
    assert_eq!(refused.status, StatusCode::CONFLICT);
    assert_eq!(refused.json["error"]["code"], "command_applied");
    assert_eq!(counts(&pool, org).await, (1, 2, 1));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn pay_group_retry_uses_current_stored_sensitivity(pool: PgPool) {
    let (service, token, mut input, org, actor, _) = fixture(&pool).await;
    input["sensitive"] = json!(false);
    let key = Uuid::new_v4().to_string();
    let created = keyed(service.clone(), &token, input.clone(), &key).await;
    assert_eq!(created.status, StatusCode::CREATED);
    assert_eq!(
        keyed(service.clone(), &token, input.clone(), &key)
            .await
            .json,
        created.json
    );
    // rls-arming: ok owner changes stored facts and removes sensitive clearance between requests.
    sqlx::query("UPDATE pay_groups SET sensitive=true WHERE id=$1")
        .bind(Uuid::parse_str(created.json["id"].as_str().unwrap()).unwrap())
        .execute(&pool)
        .await
        .unwrap();
    // rls-arming: ok only the fixture's sensitive role grant is revoked.
    sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=granted_by WHERE org_id=$1 AND account_id=$2 AND role_id IN (SELECT role_id FROM access_role_lines WHERE org_id=$1 AND domain='sensitive')")
        .bind(org.as_uuid()).bind(actor.as_uuid()).execute(&pool).await.unwrap();
    let refused = keyed(service, &token, input, &key).await;
    assert_eq!(refused.status, StatusCode::CONFLICT, "{}", refused.json);
    assert_eq!(refused.json["error"]["code"], "command_applied");
    assert_eq!(counts(&pool, org).await, (1, 1, 1));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn pay_group_retry_keys_are_tenant_isolated(pool: PgPool) {
    let (a, a_token, a_input, a_org, _, _) = fixture(&pool).await;
    let (b, b_token, b_input, b_org, _, _) = fixture(&pool).await;
    let key = Uuid::new_v4().to_string();
    let created_a = keyed(a.clone(), &a_token, a_input.clone(), &key).await;
    let created_b = keyed(b.clone(), &b_token, b_input.clone(), &key).await;
    assert_eq!(created_a.status, StatusCode::CREATED);
    assert_eq!(created_b.status, StatusCode::CREATED);
    assert_ne!(created_a.json["id"], created_b.json["id"]);
    assert_eq!(keyed(a, &a_token, a_input, &key).await.json, created_a.json);
    assert_eq!(keyed(b, &b_token, b_input, &key).await.json, created_b.json);
    assert_eq!(counts(&pool, a_org).await, (1, 1, 1));
    assert_eq!(counts(&pool, b_org).await, (1, 1, 1));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn pay_group_retry_rechecks_module_readiness(pool: PgPool) {
    let (service, token, input, org, actor, _) = fixture(&pool).await;
    let key = Uuid::new_v4().to_string();
    let created = keyed(service.clone(), &token, input.clone(), &key).await;
    assert_eq!(created.status, StatusCode::CREATED);
    assert_eq!(
        keyed(service.clone(), &token, input.clone(), &key)
            .await
            .json,
        created.json
    );
    for enabled in [false, true] {
        // rls-arming: ok fixture changes the tenant module setting between identical requests.
        let effective: OffsetDateTime = sqlx::query_scalar("INSERT INTO tenant_setting_overrides(org_id,key,value,effective_from,set_by,reason_code) VALUES ($1,'module.payroll.enabled',$2,clock_timestamp(),$3,'POLICY_REVIEW') RETURNING effective_from")
            .bind(org.as_uuid()).bind(json!(enabled)).bind(actor.as_uuid()).fetch_one(&pool).await.unwrap();
        if let Ok(wait) = (effective - OffsetDateTime::now_utc()).try_into() {
            tokio::time::sleep(wait).await;
        }
        let replay = keyed(service.clone(), &token, input.clone(), &key).await;
        if enabled {
            assert_eq!(replay.status, StatusCode::CREATED);
            assert_eq!(replay.json, created.json);
        } else {
            assert_eq!(replay.status, StatusCode::CONFLICT);
            assert_eq!(replay.json["error"]["code"], "command_applied");
        }
    }
    assert_eq!(counts(&pool, org).await, (1, 1, 1));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn pay_group_retry_refuses_unbound_saved_results(pool: PgPool) {
    let (service, token, input, org, _, _) = fixture(&pool).await;
    let key = Uuid::new_v4().to_string();
    let created = keyed(service.clone(), &token, input.clone(), &key).await;
    assert_eq!(created.status, StatusCode::CREATED);
    assert_eq!(
        keyed(service.clone(), &token, input.clone(), &key)
            .await
            .json,
        created.json
    );
    let other = keyed(
        service.clone(),
        &token,
        input.clone(),
        &Uuid::new_v4().to_string(),
    )
    .await;
    let mut wrong_id = created.json.clone();
    wrong_id["id"] = other.json["id"].clone();
    // rls-arming: ok owner reads the immutable binding to seed malformed historical outcomes separately.
    let touched: Value = sqlx::query_scalar(
        "SELECT touched FROM command_outcomes WHERE org_id=$1 AND idempotency_key=$2",
    )
    .bind(org.as_uuid())
    .bind(&key)
    .fetch_one(&pool)
    .await
    .unwrap();
    for (result, touched) in [
        (json!({}), touched.clone()),
        (json!({"id":"invalid"}), touched.clone()),
        (wrong_id, touched),
        (created.json.clone(), json!([])),
        (
            created.json.clone(),
            json!([{"type":"other","id":created.json["id"]}]),
        ),
    ] {
        let retry_key = Uuid::new_v4().to_string();
        // rls-arming: ok owner seeds a malformed saved result without changing any settled outcome.
        sqlx::query("INSERT INTO command_outcomes(org_id,actor_id,idempotency_key,command,request_fingerprint,state,result,touched,settled_at,response_status) SELECT org_id,actor_id,$3,command,request_fingerprint,'APPLIED',$4,$5,now(),201 FROM command_outcomes WHERE org_id=$1 AND idempotency_key=$2")
            .bind(org.as_uuid()).bind(&key).bind(&retry_key).bind(result).bind(touched).execute(&pool).await.unwrap();
        let refused = keyed(service.clone(), &token, input.clone(), &retry_key).await;
        assert_eq!(refused.status, StatusCode::CONFLICT);
        assert_eq!(refused.json["error"]["code"], "command_applied");
    }
    assert_eq!(counts(&pool, org).await, (2, 7, 2));
}
