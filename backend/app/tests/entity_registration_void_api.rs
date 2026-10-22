// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Acceptance and negative suite for voidBusinessRegistration (`POST /api/v1/business-registrations/{id}/void`).
//!
//! Asserts permission and tenant boundaries, refusal remedies, record_in_use only
//! for non-voided workplaces, idempotent replay, and zero business writes on refusals.

use console_kernel_core::{AccessScope, AccessScopeLevel, OrgId, ScopeNodeId};
use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings};
use console_platform_test_support::soft_passkey::SoftKey;
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

#[path = "support/http.rs"]
mod support;
use support::{add_user, address, ctx, entity_body, structure, tenant};

#[path = "support/refusals.rs"]
mod refusals;
use refusals::code;

const ADMIN: &[&str] = &["SUPER_ADMIN"];

async fn refused(
    pool: &PgPool,
    ctx: &support::Ctx,
    method: &str,
    uri: &str,
    body: Option<Value>,
    status: StatusCode,
    want: &str,
) -> Value {
    let business = refusals::business_state(pool, ctx.org).await;
    let audits = refusals::audit_rows(pool, ctx.org).await;
    let commands = support::count(pool, "command_outcomes", ctx.org).await;
    let (got, first) = ctx.call(method, uri, body.clone()).await;
    assert_eq!(got, status, "{first}");
    assert!(
        code(&first) == want || refusals::field_codes(&first).iter().any(|(_, c)| c == want),
        "expected {want}: {first}"
    );
    assert_eq!(refusals::business_state(pool, ctx.org).await, business);
    assert_eq!(refusals::audit_rows(pool, ctx.org).await, audits + 2);
    assert_eq!(
        support::count(pool, "command_outcomes", ctx.org).await,
        commands + 1
    );
    refusals::refused(pool, ctx, method, uri, body, status, want).await;
    first
}

async fn registration_of(pool: &PgPool, entity: &str) -> String {
    let id: Uuid =
        sqlx::query_scalar("SELECT id FROM business_registrations WHERE legal_entity_id = $1")
            .bind(Uuid::parse_str(entity).unwrap())
            .fetch_one(pool)
            .await
            .unwrap();
    id.to_string()
}

async fn create_unattached_registration(ctx: &support::Ctx, brn: &str) -> String {
    let mut entity = entity_body();
    entity["name"] = json!("주식회사 나다");
    let (status, created) = ctx
        .call("POST", "/api/v1/legal-entities", Some(entity))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let entity_id = created["record"]["id"].as_str().unwrap();

    let (status, reg) = ctx
        .call(
            "POST",
            &format!("/api/v1/legal-entities/{entity_id}/registrations"),
            Some(json!({
                "brn": brn,
                "trade_name": "주식회사 나다",
                "opened_on": "2020-03-02",
                "business_address": address(),
                "unit_taxation": false,
                "tax_office_label": "역삼세무서",
                "tax_type": "01",
                "business_types": [{
                    "is_main": true,
                    "sector": "정보통신업",
                    "item": "응용 소프트웨어 개발"
                }],
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{reg}");
    reg["record"]["id"].as_str().unwrap().to_owned()
}

/// 403: voiding a business registration without legal_entity:manage is refused
/// and writes nothing; another tenant's manager gets 404 with no business writes.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn void_registration_without_permission_is_forbidden_and_writes_nothing(pool: PgPool) {
    let (org, owner) = tenant(&pool, ADMIN).await;
    let admin = ctx(&pool, org, owner, ADMIN, None).await;
    let (entity, ..) = structure(&admin).await;
    let reg = registration_of(&pool, &entity).await;

    for roles in [&["ADMIN"][..], &["MEMBER"][..]] {
        let user = add_user(&pool, org, roles).await;
        let member_ctx = ctx(&pool, org, user, roles, None).await;
        refused(
            &pool,
            &member_ctx,
            "POST",
            &format!("/api/v1/business-registrations/{reg}/void"),
            Some(json!({ "reason_code": "MISTAKE" })),
            StatusCode::FORBIDDEN,
            "forbidden",
        )
        .await;
    }

    let business = refusals::business_state(&pool, org).await;
    let audits = refusals::audit_rows(&pool, org).await;
    let (other_org, other_owner) = tenant(&pool, ADMIN).await;
    let other = ctx(&pool, other_org, other_owner, ADMIN, None).await;
    refused(
        &pool,
        &other,
        "POST",
        &format!("/api/v1/business-registrations/{reg}/void"),
        Some(json!({ "reason_code": "MISTAKE" })),
        StatusCode::NOT_FOUND,
        "registration_not_found",
    )
    .await;
    assert_eq!(refusals::business_state(&pool, org).await, business);
    assert_eq!(refusals::audit_rows(&pool, org).await, audits);

    let is_voided: bool = sqlx::query_scalar(
        "SELECT voided_at IS NOT NULL FROM business_registrations WHERE id = $1",
    )
    .bind(Uuid::parse_str(&reg).unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        !is_voided,
        "registration must remain un-voided after 403 refusal"
    );
}

/// A branch-scoped manager cannot void its registration's 법인-level record.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn void_registration_outside_the_managers_scope_is_forbidden(pool: PgPool) {
    let (org, owner) = tenant(&pool, ADMIN).await;
    let admin = ctx(&pool, org, owner, ADMIN, None).await;
    let (entity, workplace, branch, _) = structure(&admin).await;
    let reg = registration_of(&pool, &entity).await;
    let roles = &["EXECUTIVE"];
    let user = add_user(&pool, org, roles).await;
    let keys = support::keys();
    let issuer = JwtIssuer::from_es256_pem(
        JwtSettings {
            issuer: "console-platform-auth".into(),
            audience: "console-api".into(),
            access_token_ttl: time::Duration::minutes(15),
        },
        keys.0.as_bytes(),
        keys.1.as_bytes(),
    )
    .unwrap();
    let token = console_platform_test_support::issue_session_token(
        &pool,
        &issuer,
        AccessTokenInput {
            subject: user,
            org_id: OrgId::from_uuid(org),
            roles: roles.iter().map(|r| (*r).to_owned()).collect(),
            branches: Vec::new(),
            display_name: None,
            feature_grants: Vec::new(),
            platform: false,
            view_as: false,
            read_only: false,
            authz_subject_version: 0,
            authz_policy_version: 0,
            session_generation: 0,
            issued_at: time::OffsetDateTime::now_utc(),
        },
        Some(AccessScope::new(
            AccessScopeLevel::Branch,
            ScopeNodeId::from_uuid(Uuid::parse_str(&branch).unwrap()),
        )),
        vec![],
    )
    .await;
    let manager = support::Ctx {
        service: console_app::build_router(support::app_state(
            support::role_pool(&pool, "console_rt", None).await,
            support::role_pool(&pool, "console_leave_cmd", None).await,
            &keys,
        )),
        token,
        org,
        user,
        key: std::cell::Cell::new(Uuid::nil()),
    };
    refused(
        &pool,
        &manager,
        "POST",
        &format!("/api/v1/business-registrations/{reg}/void"),
        Some(json!({ "reason_code": "MISTAKE" })),
        StatusCode::FORBIDDEN,
        "forbidden",
    )
    .await;

    let (status, body) = manager
        .call(
            "POST",
            &format!("/api/v1/workplaces/{workplace}/void"),
            Some(json!({ "reason_code": "MISTAKE" })),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "grant works in scope: {body}"
    );
}

/// phase_not_setup: voiding after go-live (OPERATING phase) is refused with
/// phase_not_setup, naming close_record_instead, and writes nothing.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn void_registration_refuses_with_phase_not_setup_after_go_live(pool: PgPool) {
    let (org, owner) = tenant(&pool, ADMIN).await;
    let admin = ctx(&pool, org, owner, ADMIN, None).await;
    let mut passkey = SoftKey::enroll(&pool, OrgId::from_uuid(org), owner).await;
    let (entity, _, branch, unit) = structure(&admin).await;
    let reg = registration_of(&pool, &entity).await;
    let (status, person) = admin
        .call(
            "POST",
            "/api/v1/employees",
            Some(support::employee_body("E-1", &branch, &unit)),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{person}");
    let (status, preview) = admin
        .call("GET", "/api/v1/onboarding/go-live/preview", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["blockers"], json!([]), "{preview}");
    let step_up = passkey.step_up(&pool).await;
    let (status, live) = admin.call(
        "POST", "/api/v1/onboarding/go-live",
        Some(json!({ "digest": preview["digest"], "step_up": step_up, "sole_holder_acknowledged": true })),
    ).await;
    assert_eq!(status, StatusCode::OK, "{live}");
    assert_eq!(live["phase"], "OPERATING");

    let refusal = refused(
        &pool,
        &admin,
        "POST",
        &format!("/api/v1/business-registrations/{reg}/void"),
        Some(json!({ "reason_code": "MISTAKE" })),
        StatusCode::CONFLICT,
        "phase_not_setup",
    )
    .await;
    assert_eq!(refusal["error"]["reasons"], json!(["close_record_instead"]));

    let is_voided: bool = sqlx::query_scalar(
        "SELECT voided_at IS NOT NULL FROM business_registrations WHERE id = $1",
    )
    .bind(Uuid::parse_str(&reg).unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        !is_voided,
        "registration must remain un-voided after phase_not_setup refusal"
    );
}

/// record_in_use: voiding a registration that has workplaces filing under it
/// is refused with 409 record_in_use (remedy: move_workplaces_first).
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn void_registration_refuses_with_record_in_use_when_workplaces_file_under_it(pool: PgPool) {
    let (org, owner) = tenant(&pool, ADMIN).await;
    let admin = ctx(&pool, org, owner, ADMIN, None).await;
    let (entity, workplace, ..) = structure(&admin).await;
    let reg = registration_of(&pool, &entity).await;

    let refusal = refused(
        &pool,
        &admin,
        "POST",
        &format!("/api/v1/business-registrations/{reg}/void"),
        Some(json!({ "reason_code": "MISTAKE" })),
        StatusCode::CONFLICT,
        "record_in_use",
    )
    .await;
    assert_eq!(
        refusal["error"]["reasons"],
        json!(["move_workplaces_first"])
    );

    let is_voided: bool = sqlx::query_scalar(
        "SELECT voided_at IS NOT NULL FROM business_registrations WHERE id = $1",
    )
    .bind(Uuid::parse_str(&reg).unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        !is_voided,
        "registration must remain un-voided after record_in_use refusal"
    );

    sqlx::query("UPDATE workplaces SET closed_on = '2020-03-03' WHERE id = $1")
        .bind(Uuid::parse_str(&workplace).unwrap())
        .execute(&pool)
        .await
        .unwrap();
    refused(
        &pool,
        &admin,
        "POST",
        &format!("/api/v1/business-registrations/{reg}/void"),
        Some(json!({ "reason_code": "MISTAKE" })),
        StatusCode::CONFLICT,
        "record_in_use",
    )
    .await;

    let (status, body) = admin
        .call(
            "POST",
            &format!("/api/v1/workplaces/{workplace}/void"),
            Some(json!({ "reason_code": "MISTAKE" })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    let (status, body) = admin
        .call(
            "POST",
            &format!("/api/v1/business-registrations/{reg}/void"),
            Some(json!({ "reason_code": "MISTAKE" })),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "voided workplace no longer blocks: {body}"
    );
    let is_voided: bool = sqlx::query_scalar(
        "SELECT voided_at IS NOT NULL FROM business_registrations WHERE id = $1",
    )
    .bind(Uuid::parse_str(&reg).unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(is_voided);
}

/// idempotent replay: voiding an unattached registration in SETUP succeeds
/// with 204; the platform replays a command without a stored result as 409 command_applied.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn void_registration_in_setup_succeeds_and_replays_idempotently(pool: PgPool) {
    let (org, owner) = tenant(&pool, ADMIN).await;
    let admin = ctx(&pool, org, owner, ADMIN, None).await;
    let reg = create_unattached_registration(&admin, "000-81-00010").await;
    let reg_uuid = Uuid::parse_str(&reg).unwrap();

    let uri = format!("/api/v1/business-registrations/{reg}/void");
    let body = json!({ "reason_code": "MISTAKE" });

    // First call voids the registration
    let (status, first) = admin.call("POST", &uri, Some(body.clone())).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{first}");

    let (is_voided, reason): (bool, Option<String>) = sqlx::query_as(
        "SELECT voided_at IS NOT NULL, void_reason_code FROM business_registrations WHERE id = $1",
    )
    .bind(reg_uuid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(is_voided, "registration must be voided");
    assert_eq!(reason.as_deref(), Some("MISTAKE"));
    assert_eq!(
        support::audits(&pool, org, "business_registration.void").await,
        1
    );
    let business = refusals::business_state(&pool, org).await;

    let audits = refusals::audit_rows(&pool, org).await;
    let commands = support::count(&pool, "command_outcomes", org).await;
    let (status, retry) = admin.retry("POST", &uri, Some(body)).await;
    assert_eq!(refusals::business_state(&pool, org).await, business);
    assert_eq!(
        (
            status,
            refusals::audit_rows(&pool, org).await,
            support::count(&pool, "command_outcomes", org).await
        ),
        (StatusCode::CONFLICT, audits + 1, commands),
        "replay must add only the platform replay audit: {retry}"
    );
    assert_eq!(code(&retry), "command_applied");
    let command_id: Uuid = sqlx::query_scalar(
        "SELECT id FROM command_outcomes WHERE org_id = $1 AND idempotency_key = $2",
    )
    .bind(org)
    .bind(admin.key.get().to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(retry["error"]["operation_id"], command_id.to_string());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn void_registration_rejects_reused_key_and_fresh_void_without_a_second_write(pool: PgPool) {
    let (org, owner) = tenant(&pool, ADMIN).await;
    let admin = ctx(&pool, org, owner, ADMIN, None).await;
    let reg = create_unattached_registration(&admin, "000-81-00010").await;
    let uri = format!("/api/v1/business-registrations/{reg}/void");
    let (status, first) = admin
        .call("POST", &uri, Some(json!({"reason_code": "MISTAKE"})))
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{first}");
    let business = refusals::business_state(&pool, org).await;
    let audits = refusals::audit_rows(&pool, org).await;
    let commands = support::count(&pool, "command_outcomes", org).await;
    let outcomes: Value = sqlx::query_scalar(
        "SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM command_outcomes r WHERE org_id = $1",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .unwrap();
    for _ in 0..2 {
        let (status, mismatch) = admin
            .retry("POST", &uri, Some(json!({"reason_code": "DUPLICATE"})))
            .await;
        assert_eq!(status, StatusCode::CONFLICT, "{mismatch}");
        assert_eq!(code(&mismatch), "idempotency_key_reused");
    }
    assert_eq!(refusals::business_state(&pool, org).await, business);
    assert_eq!(
        support::count(&pool, "command_outcomes", org).await,
        commands
    );
    let after: Value = sqlx::query_scalar(
        "SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM command_outcomes r WHERE org_id = $1",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(after, outcomes);
    assert_eq!(refusals::audit_rows(&pool, org).await, audits + 2);
    assert_eq!(
        support::audits(&pool, org, "business_registration.void").await,
        1
    );
    refused(
        &pool,
        &admin,
        "POST",
        &uri,
        Some(json!({"reason_code": "MISTAKE"})),
        StatusCode::NOT_FOUND,
        "registration_not_found",
    )
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn void_registration_rejects_invalid_reasons_and_missing_key(pool: PgPool) {
    let (org, owner) = tenant(&pool, ADMIN).await;
    let admin = ctx(&pool, org, owner, ADMIN, None).await;
    let reg = create_unattached_registration(&admin, "000-81-00010").await;
    let uri = format!("/api/v1/business-registrations/{reg}/void");
    for (body, want) in [
        (json!({}), "required"),
        (json!({"reason_code": "  "}), "required"),
        (json!({"reason_code": "CREATE"}), "reason_code_reserved"),
        (json!({"reason_code": "x".repeat(101)}), "too_long"),
    ] {
        let refusal = refused(
            &pool,
            &admin,
            "POST",
            &uri,
            Some(body),
            StatusCode::UNPROCESSABLE_ENTITY,
            want,
        )
        .await;
        assert!(
            refusals::field_codes(&refusal).contains(&("reason_code".into(), want.into())),
            "{refusal}"
        );
    }
    let business = refusals::business_state(&pool, org).await;
    let audits = refusals::audit_rows(&pool, org).await;
    let commands = support::count(&pool, "command_outcomes", org).await;
    for attempt in 1..=2 {
        let (status, missing) = admin
            .send("POST", &uri, Some(json!({"reason_code": "MISTAKE"})), None)
            .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{missing}");
        assert!(
            refusals::field_codes(&missing)
                .contains(&("Idempotency-Key".into(), "required".into())),
            "{missing}"
        );
        assert_eq!(refusals::business_state(&pool, org).await, business);
        assert_eq!(
            support::count(&pool, "command_outcomes", org).await,
            commands + attempt
        );
        assert_eq!(refusals::audit_rows(&pool, org).await, audits + 2 * attempt);
    }
}

async fn blocked_pid(pool: &PgPool, blocker: i32) -> i32 {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let pid: Option<i32> = sqlx::query_scalar(
                "SELECT pid FROM pg_stat_activity WHERE datname = current_database() \
                 AND $1 = ANY(pg_blocking_pids(pid)) LIMIT 1",
            )
            .bind(blocker)
            .fetch_optional(pool)
            .await
            .unwrap();
            if let Some(pid) = pid {
                return pid;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("request must reach the coordinated database lock")
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn void_registration_serializes_with_workplace_creation(pool: PgPool) {
    let (org, owner) = tenant(&pool, ADMIN).await;
    let creator = ctx(&pool, org, owner, ADMIN, None).await;
    let voider = ctx(
        &pool,
        org,
        owner,
        ADMIN,
        Some("SET test.registration_void_barrier = 'on'"),
    )
    .await;
    let reg = create_unattached_registration(&creator, "000-81-00010").await;
    let reg_id = Uuid::parse_str(&reg).unwrap();
    let entity: Uuid =
        sqlx::query_scalar("SELECT legal_entity_id FROM business_registrations WHERE id = $1")
            .bind(reg_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    // Pause void after its in-use check, before UPDATE takes a registration row lock.
    sqlx::raw_sql(
        "CREATE FUNCTION test_pause_registration_void() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF current_setting('test.registration_void_barrier', true) = 'on' THEN
                PERFORM pg_advisory_xact_lock(2713);
            END IF;
            RETURN NULL;
        END $$;
        CREATE TRIGGER test_pause_registration_void BEFORE UPDATE ON business_registrations
        FOR EACH STATEMENT EXECUTE FUNCTION test_pause_registration_void();",
    )
    .execute(&pool)
    .await
    .unwrap();
    let mut barrier = pool.begin().await.unwrap();
    let barrier_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *barrier)
        .await
        .unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(2713)")
        .execute(&mut *barrier)
        .await
        .unwrap();
    let workplaces = format!("/api/v1/legal-entities/{entity}/workplaces");
    let void_uri = format!("/api/v1/business-registrations/{reg}/void");
    let workplace_body = json!({
        "name": "본사", "registration_id": reg, "same_address_as_registration": true,
        "opened_on": "2020-03-02", "is_head_office": true, "kind_code": "HEAD_OFFICE",
        "insurance": { "shortcut": "ALL_ESTABLISHED_NUMBERS_LATER" },
    });
    let (voided, created) = tokio::join!(
        voider.call("POST", &void_uri, Some(json!({ "reason_code": "MISTAKE" }))),
        async {
            let voider_pid = blocked_pid(&pool, barrier_pid).await;
            let create = creator.call("POST", &workplaces, Some(workplace_body));
            tokio::pin!(create);
            let completed = tokio::select! {
                response = &mut create => Some(response),
                _ = blocked_pid(&pool, voider_pid) => None,
            };
            barrier.rollback().await.unwrap();
            match completed {
                Some(response) => response,
                None => create.await,
            }
        }
    );
    let orphans: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM workplaces w JOIN business_registrations r ON r.id = w.registration_id \
         WHERE r.id = $1 AND r.voided_at IS NOT NULL AND w.voided_at IS NULL",
    ).bind(reg_id).fetch_one(&pool).await.unwrap();
    assert_eq!(
        orphans, 0,
        "concurrent create ({}) and void ({}) left an active workplace under voided registration {reg}",
        created.0, voided.0
    );
    if created.0 == StatusCode::CREATED {
        assert_eq!(voided.0, StatusCode::CONFLICT, "{:?}", voided.1);
        assert_eq!(code(&voided.1), "record_in_use");
    } else {
        assert_eq!(voided.0, StatusCode::NO_CONTENT, "{:?}", voided.1);
        assert_eq!(
            created.0,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{:?}",
            created.1
        );
        assert!(
            refusals::field_codes(&created.1)
                .contains(&("registration_id".into(), "registration_not_found".into())),
            "{:?}",
            created.1
        );
    }
}
