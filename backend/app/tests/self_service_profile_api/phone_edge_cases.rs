// SPDX-License-Identifier: LicenseRef-Proprietary
use console_kernel_core::UserId;
use console_platform_test_support::soft_passkey::SoftKey;
use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use super::seed::seed_profile_fixture;
use super::support::{call_json, gen_keys, role_pool, token_for};
use super::{app_router, reveal_with_binding};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn patch_phone_never_collides_with_users_phone_or_leaks_cleared_fallback(pool: PgPool) {
    let (priv_pem, pub_pem) = gen_keys();
    let mut fx = seed_profile_fixture(&pool, &priv_pem, &pub_pem).await;
    let app = app_router(role_pool(&pool, "console_rt").await, priv_pem, pub_pem);

    // Seed cross-tenant user_b and same-tenant other_a with distinct global users.phone values.
    let other_a = UserId::new();
    sqlx::query("UPDATE users SET phone = '+821066665555' WHERE org_id = $1 AND id = $2")
        .bind(fx.org_b.as_uuid())
        .bind(fx.user_b.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id, phone) VALUES ($1, 'PeerA', $2, $3, '+821077776666')")
        .bind(other_a.as_uuid())
        .bind(["MEMBER"].as_slice())
        .bind(fx.org_a.as_uuid())
        .execute(&pool)
        .await
        .unwrap();

    // 1. Cross-tenant & same-tenant users.phone match succeeds (200) and leaves users.phone untouched.
    let (st, _, b1) = call_json(
        app.clone(),
        "PATCH",
        "/api/v1/me/profile",
        Some(&fx.tok_a),
        Some(json!({"phone": "010-6666-5555"})),
        &[],
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{b1}");
    assert_eq!(b1["phone_masked"], "010-••••-5555");

    let (st, _, b2) = call_json(
        app.clone(),
        "PATCH",
        "/api/v1/me/profile",
        Some(&fx.tok_a),
        Some(json!({"phone": "010-7777-6666"})),
        &[],
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{b2}");
    assert_eq!(b2["phone_masked"], "010-••••-6666");

    let user_a_phone: Option<String> = sqlx::query_scalar("SELECT phone FROM users WHERE id = $1")
        .bind(fx.user_a.as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
    let user_b_phone: Option<String> = sqlx::query_scalar("SELECT phone FROM users WHERE id = $1")
        .bind(fx.user_b.as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(user_a_phone.as_deref(), Some("+821012345678"));
    assert_eq!(user_b_phone.as_deref(), Some("+821066665555"));

    // 2. Clearing phone when users.phone is non-null yields null / 404 reveal and preserves users.phone.
    let (st, _, cleared) = call_json(
        app.clone(),
        "PATCH",
        "/api/v1/me/profile",
        Some(&fx.tok_a),
        Some(json!({"phone": null})),
        &[],
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{cleared}");
    assert!(cleared["phone_masked"].is_null(), "{cleared}");

    let (st, _, prof_after) = call_json(
        app.clone(),
        "GET",
        "/api/v1/me/profile",
        Some(&fx.tok_a),
        None,
        &[],
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{prof_after}");
    assert!(prof_after["phone_masked"].is_null(), "{prof_after}");

    let (st, _, rev_after) = reveal_with_binding(
        &pool,
        app,
        &fx.tok_a,
        *fx.user_a.as_uuid(),
        fx.emp_a,
        &mut fx.key,
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND, "{rev_after}");
    let user_a_phone_after: Option<String> =
        sqlx::query_scalar("SELECT phone FROM users WHERE id = $1")
            .bind(fx.user_a.as_uuid())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(user_a_phone_after.as_deref(), Some("+821012345678"));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn patch_and_reveal_phone_for_profileless_employee_with_person_revisions(pool: PgPool) {
    let (priv_pem, pub_pem) = gen_keys();
    let fx = seed_profile_fixture(&pool, &priv_pem, &pub_pem).await;
    let emp_noprof = Uuid::new_v4();
    let user_noprof = UserId::new();
    sqlx::query(
        "INSERT INTO employees (id, org_id, company, name, position, employee_number, hire_date, hire_on, employment_status, source_filename, source_sheet, source_row, source_key) \
         VALUES ($1, $2, 'Co', 'NoProf', 'Staff', 'E-099', '2024-04-01', '2024-04-01', 'ACTIVE', 'f', 's', 2, $1::text)",
    )
    .bind(emp_noprof)
    .bind(fx.org_a.as_uuid())
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id, employee_id) VALUES ($1, 'NoProf', $2, $3, $4)")
        .bind(user_noprof.as_uuid())
        .bind(["MEMBER"].as_slice())
        .bind(fx.org_a.as_uuid())
        .bind(emp_noprof)
        .execute(&pool)
        .await
        .unwrap();
    let person_id: Uuid = sqlx::query_scalar("SELECT console_bind_employee_person($1, $2, $3)")
        .bind(fx.org_a.as_uuid())
        .bind(emp_noprof)
        .bind(user_noprof.as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query(
        "SELECT console_revise_person_facts($1, $2, '{\"phone\":\"+821033334444\"}'::jsonb, NULL)",
    )
    .bind(fx.org_a.as_uuid())
    .bind(person_id)
    .execute(&pool)
    .await
    .unwrap();

    let mut key = SoftKey::enroll(&pool, fx.org_a, user_noprof).await;
    let tok = token_for(
        &pool,
        &priv_pem,
        &pub_pem,
        fx.org_a,
        user_noprof,
        vec!["MEMBER".into()],
        vec![],
    )
    .await;
    let app = app_router(role_pool(&pool, "console_rt").await, priv_pem, pub_pem);

    let (st, _, init) = call_json(
        app.clone(),
        "GET",
        "/api/v1/me/profile",
        Some(&tok),
        None,
        &[],
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{init}");
    assert_eq!(init["phone_masked"], "010-••••-4444");

    let (st, _, patched) = call_json(
        app.clone(),
        "PATCH",
        "/api/v1/me/profile",
        Some(&tok),
        Some(json!({"phone": "010-9999-8888"})),
        &[],
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{patched}");
    assert_eq!(patched["phone_masked"], "010-••••-8888");

    let (st, _, after_get) = call_json(
        app.clone(),
        "GET",
        "/api/v1/me/profile",
        Some(&tok),
        None,
        &[],
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{after_get}");
    assert_eq!(after_get["phone_masked"], "010-••••-8888");

    let (st, _, rev) = reveal_with_binding(
        &pool,
        app,
        &tok,
        *user_noprof.as_uuid(),
        emp_noprof,
        &mut key,
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{rev}");
    assert_eq!(rev["value"], "+821099998888");
}
