// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_entity_adapter_postgres::PgEntityStore;
use console_entity_application::registration_check::{
    CheckAnswer, CheckAvailability, CheckFailure, CheckKind, FakeRegistrationCheck,
    RegistrationCheck, UnavailableReason, UserValidation,
};
use console_entity_domain::codes::OperatingStatus;
use console_entity_rest::EntityRestState;
use console_platform_auth::{JwtSettings, JwtVerifier};
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{future::Future, pin::Pin, sync::Arc};
use uuid::Uuid;
#[path = "registration_check/delivery.rs"]
mod delivery;
#[path = "support/http.rs"]
mod support;

const ADMIN: &[&str] = &["SUPER_ADMIN"];
const BRN: &str = "0008100009";
fn fake(kind: CheckKind, valid: Option<&str>) -> Arc<FakeRegistrationCheck> {
    let mut a = CheckAnswer::status(BRN, "01");
    a.kind = kind;
    a.valid = valid.map(str::to_owned);
    if kind == CheckKind::Validate {
        a.fields_sent = vec!["b_no".into(), "start_dt".into(), "p_nm".into()];
    }
    a.reported_status = Some(OperatingStatus::Continuing);
    if valid == Some("02") {
        a.status_code = None;
        a.reported_status = None;
    }
    a.response_sha256 = "b".repeat(64);
    Arc::new(FakeRegistrationCheck::configured(vec![a]))
}
async fn context(
    pool: &PgPool,
    port: Option<Arc<dyn RegistrationCheck>>,
) -> (support::Ctx, String, Uuid, (String, String)) {
    let (org, user) = support::tenant(pool, ADMIN).await;
    let keys = support::keys();
    let jwt = JwtVerifier::from_es256_public_pem(
        JwtSettings {
            issuer: "console-platform-auth".into(),
            audience: "console-api".into(),
            access_token_ttl: time::Duration::minutes(15),
        },
        keys.1.as_bytes(),
    )
    .unwrap();
    let mut state = EntityRestState::new(
        PgEntityStore::new(support::role_pool(pool, "console_rt", None).await),
        Some(jwt),
        None,
    );
    if let Some(port) = port {
        state = state.with_registration_check(port);
    }
    let ctx = support::Ctx {
        service: console_entity_rest::router(state),
        token: support::token(pool, &keys, org, user, ADMIN).await,
        org,
        user,
        key: std::cell::Cell::new(Uuid::nil()),
    };
    let (status, entity) = ctx
        .call(
            "POST",
            "/api/v1/legal-entities",
            Some(support::entity_body()),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{entity}");
    let entity = entity["record"]["id"].as_str().unwrap().to_owned();
    let (status, reg) = ctx.call("POST",&format!("/api/v1/legal-entities/{entity}/registrations"),Some(json!({
        "brn":BRN,"opened_on":"2020-03-02","business_address":support::address(),"unit_taxation":false,
        "tax_office_label":"삼성세무서","tax_type":"01","business_types":[{"is_main":true,"sector":"정보통신업","item":"소프트웨어 개발"}]
    }))).await;
    assert_eq!(status, StatusCode::CREATED, "{reg}");
    (
        ctx,
        entity,
        reg["record"]["id"].as_str().unwrap().parse().unwrap(),
        keys,
    )
}
async fn post(ctx: &support::Ctx, id: Uuid, kind: CheckKind) -> (StatusCode, Value) {
    ctx.call(
        "POST",
        &format!("/api/v1/business-registrations/{id}/checks"),
        Some(json!({"kind":kind})),
    )
    .await
}
async fn history(ctx: &support::Ctx, id: Uuid) -> Value {
    let (status, body) = ctx
        .call(
            "GET",
            &format!("/api/v1/business-registrations/{id}/checks"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}
fn code(body: &Value) -> &str {
    body["error"]["code"].as_str().unwrap()
}

type AnswerFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, CheckFailure>> + Send + 'a>>;
struct Limited;
impl RegistrationCheck for Limited {
    fn reflection_lag_days(&self) -> i64 {
        2
    }
    fn max_batch(&self) -> usize {
        100
    }
    fn pack(&self) -> &'static str {
        "KR"
    }
    fn availability(&self) -> CheckAvailability {
        CheckAvailability::available()
    }
    fn status<'a>(&'a self, _: &'a [String]) -> AnswerFuture<'a, Vec<CheckAnswer>> {
        Box::pin(async {
            Err(CheckFailure::RateLimited {
                retry_after_seconds: 42,
                gateway_code: Some("23".into()),
            })
        })
    }
    fn validate<'a>(&'a self, _: &'a UserValidation) -> AnswerFuture<'a, CheckAnswer> {
        Box::pin(async {
            Err(CheckFailure::RateLimited {
                retry_after_seconds: 42,
                gateway_code: Some("23".into()),
            })
        })
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn availability_refusals_are_honest_for_every_reason_and_configured_checks_are_readable(
    pool: PgPool,
) {
    for (reason, label) in [
        (UnavailableReason::NotConfigured, "NOT_CONFIGURED"),
        (UnavailableReason::KeyExpired, "KEY_EXPIRED"),
        (UnavailableReason::KeyRejected, "KEY_REJECTED"),
        (UnavailableReason::ProviderDown, "PROVIDER_DOWN"),
    ] {
        let port = (reason != UnavailableReason::NotConfigured).then(|| {
            Arc::new(FakeRegistrationCheck::unavailable(reason)) as Arc<dyn RegistrationCheck>
        });
        let (ctx, _, id, _) = context(&pool, port).await;
        let (status, body) = post(&ctx, id, CheckKind::Status).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(code(&body), "registration_check_unavailable");
        assert_eq!(body["error"]["reasons"], json!([label]));
        let h = history(&ctx, id).await;
        assert_eq!(h["availability"], json!({"available":false,"reason":label}));
        assert_eq!(h["items"], json!([]));
    }
    let (ctx, entity, id, _) = context(&pool, Some(fake(CheckKind::Status, None))).await;
    let (status, body) = post(&ctx, id, CheckKind::Status).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, replay) = ctx
        .retry(
            "POST",
            &format!("/api/v1/business-registrations/{id}/checks"),
            Some(json!({"kind":"STATUS"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["id"], replay["id"]);
    let h = history(&ctx, id).await;
    assert_eq!(h["items"].as_array().unwrap().len(), 1);
    assert_eq!(h["latest_status"]["id"], body["id"]);
    assert_eq!(h["availability"]["available"], true);
    let (status, read) = ctx
        .call("GET", &format!("/api/v1/legal-entities/{entity}"), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(read["registrations"][0]["verification_tier"], "T1");
    assert_eq!(read["registrations"][0]["nts_check"]["status_code"], "01");
    assert!(read["registrations"][0]["nts_check"]["checked_at"].is_string());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rate_limit_pending_void_and_permissions_refuse_without_writing_evidence(pool: PgPool) {
    let (ctx, _, id, _) = context(&pool, Some(Arc::new(Limited))).await;
    let (status, body) = post(&ctx, id, CheckKind::Status).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert_eq!(code(&body), "registration_check_rate_limited");
    assert_eq!(body["error"]["retry_after_seconds"], 42);
    assert_eq!(history(&ctx, id).await["items"], json!([]));
    let (mut ctx, _, id, keys) = context(&pool, Some(fake(CheckKind::Status, None))).await;
    let member = support::add_user(&pool, ctx.org, &["ADMIN"]).await;
    let admin_token = ctx.token.clone();
    ctx.token = support::token(&pool, &keys, ctx.org, member, &["ADMIN"]).await;
    assert_eq!(
        post(&ctx, id, CheckKind::Status).await.0,
        StatusCode::FORBIDDEN
    );
    ctx.token = admin_token;
    assert_eq!(post(&ctx, id, CheckKind::Status).await.0, StatusCode::OK);
    sqlx::query("UPDATE business_registrations SET brn=NULL,brn_pending_reason='NEW_REGISTRATION_PENDING' WHERE id=$1").bind(id).execute(&pool).await.unwrap();
    let (status, body) = post(&ctx, id, CheckKind::Status).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(code(&body), "registration_check_no_number");
    sqlx::query("UPDATE business_registrations SET brn=$2,brn_pending_reason=NULL WHERE id=$1")
        .bind(id)
        .bind(BRN)
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = ctx
        .call(
            "POST",
            &format!("/api/v1/business-registrations/{id}/void"),
            Some(json!({"reason_code":"DUPLICATE"})),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    let (status, body) = post(&ctx, id, CheckKind::Status).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(code(&body), "registration_check_registration_ended");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn validation_invalid_never_reaches_tier_two_and_valid_user_action_does(pool: PgPool) {
    for (valid, tier) in [("02", "NONE"), ("01", "T2")] {
        let (ctx, entity, id, _) =
            context(&pool, Some(fake(CheckKind::Validate, Some(valid)))).await;
        let (status, body) = post(&ctx, id, CheckKind::Validate).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["valid"], valid);
        assert_eq!(body["trigger"], "USER");
        let h = history(&ctx, id).await;
        assert_eq!(h["latest_validate"]["valid"], valid);
        let (_, read) = ctx
            .call("GET", &format!("/api/v1/legal-entities/{entity}"), None)
            .await;
        assert_eq!(read["registrations"][0]["verification_tier"], tier);
        let persisted: Value = sqlx::query_scalar(
            "SELECT to_jsonb(c) FROM business_registration_checks c WHERE registration_id=$1",
        )
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(!persisted.to_string().contains("홍길동"));
        let purpose: Value = sqlx::query_scalar("SELECT after_snap FROM audit_events WHERE org_id=$1 AND action='business_registration.check'").bind(ctx.org).fetch_one(&pool).await.unwrap();
        assert_eq!(purpose["purpose"], "registration_evidence");
    }
}
