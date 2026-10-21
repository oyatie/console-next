#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Negative suite for people and 운영 시작 over HTTP (refusal audit,
//! tools/ci/check-refusal-tests.mjs): each refusal's status and code, that
//! nothing changed, and that a retry is refused the same way.

use console_kernel_core::OrgId;
use console_platform_test_support::soft_passkey::SoftKey;
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

#[path = "support/http.rs"]
mod support;
use support::{add_user, count, ctx, employee_body, structure, tenant};

const ADMIN: &[&str] = &["SUPER_ADMIN"];

async fn phase(pool: &PgPool, org: Uuid) -> String {
    sqlx::query_scalar("SELECT phase FROM tenant_phase WHERE org_id = $1")
        .bind(org)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// 운영 시작 needs a 부서 (LMG-ORG-6); the workplace's own unit is not one.
async fn department(pool: &PgPool, org: Uuid, actor: console_kernel_core::UserId, parent: &str) {
    let id = Uuid::new_v4();
    let attributes =
        json!({ "kind": "department", "name": "인사팀", "status": "active", "parent_id": parent });
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO org_units (org_id, id) VALUES ($1, $2)")
        .bind(org)
        .bind(id)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO org_unit_revisions (org_id, org_unit_id, version, command_id, actor_id, \
         payload_digest, attributes, receipt) VALUES ($1, $2, 1, gen_random_uuid(), $3, \
         decode(repeat('ab', 32), 'hex'), $4, '{}')",
    )
    .bind(org)
    .bind(id)
    .bind(actor.as_uuid())
    .bind(attributes)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_legacy_one_shot_import_is_gone_and_a_non_holder_is_forbidden_first(pool: PgPool) {
    let (org, owner) = tenant(&pool, ADMIN).await;
    let admin = ctx(&pool, org, owner, ADMIN, None).await;
    for _ in 0..2 {
        let (status, gone) = admin
            .call("POST", "/api/v1/employees/import", Some(json!({})))
            .await;
        assert_eq!(status, StatusCode::GONE, "{gone}");
        assert_eq!(gone["error"]["code"], "legacy_import_removed");
    }
    let member = add_user(&pool, org, &["MEMBER"]).await;
    let member = ctx(&pool, org, member, &["MEMBER"], None).await;
    let (status, refused) = member
        .call("POST", "/api/v1/employees/import", Some(json!({})))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
    assert_eq!(count(&pool, "employees", org).await, 0);
}

/// 운영 시작 is ops-only, bound to the preview the person saw, and
/// one-way; every refusal leaves the tenant in SETUP (or OPERATING after).
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn go_live_refuses_a_non_holder_a_stale_preview_and_a_second_time(pool: PgPool) {
    let (org, owner) = tenant(&pool, ADMIN).await;
    let mut passkey = SoftKey::enroll(&pool, OrgId::from_uuid(org), owner).await;
    let ctx = ctx(&pool, org, owner, ADMIN, None).await;
    let (_, _, branch, unit) = structure(&ctx).await;
    department(&pool, org, owner, &unit).await;
    let (status, _) = ctx
        .call(
            "POST",
            "/api/v1/employees",
            Some(employee_body("E-1", &branch, &unit)),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, preview) = ctx
        .call("GET", "/api/v1/onboarding/go-live/preview", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    let digest = preview["digest"].as_str().unwrap().to_owned();
    let go = |digest: &str, step_up: Value| json!({ "digest": digest, "step_up": step_up, "sole_holder_acknowledged": true });

    let other = add_user(&pool, org, &["ADMIN"]).await;
    let other = support::ctx(&pool, org, other, &["ADMIN"], None).await;
    let (status, refused) = other
        .call(
            "POST",
            "/api/v1/onboarding/go-live",
            Some(go(&digest, json!(null))),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
    assert_eq!(phase(&pool, org).await, "SETUP");

    let step_up = passkey.step_up(&pool).await;
    let last = if digest.ends_with('0') { "1" } else { "0" };
    let stale = format!("{}{last}", &digest[..digest.len() - 1]);
    let (status, refused) = ctx
        .call(
            "POST",
            "/api/v1/onboarding/go-live",
            Some(go(&stale, step_up)),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["error"]["code"], "preview_stale");
    assert_eq!(phase(&pool, org).await, "SETUP");

    // The new ungranted HR account is now part of the preview census.
    let (status, preview) = ctx
        .call("GET", "/api/v1/onboarding/go-live/preview", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    let digest = preview["digest"].as_str().unwrap();
    let step_up = passkey.step_up(&pool).await;
    let (status, done) = ctx
        .call(
            "POST",
            "/api/v1/onboarding/go-live",
            Some(go(digest, step_up)),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{done}");
    let step_up = passkey.step_up(&pool).await;
    let (status, again) = ctx
        .call(
            "POST",
            "/api/v1/onboarding/go-live",
            Some(go(digest, step_up)),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{again}");
    assert_eq!(again["error"]["code"], "phase_not_setup");
    assert_eq!(phase(&pool, org).await, "OPERATING");
}
