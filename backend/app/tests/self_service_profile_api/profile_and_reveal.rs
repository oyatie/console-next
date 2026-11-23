// SPDX-License-Identifier: LicenseRef-Proprietary
use http::{StatusCode, header};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use super::seed::seed_profile_fixture;
use super::support::{call_json, gen_keys, role_pool};
use super::{app_router, reveal_with_binding};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn screen6_me_profile_read_patch_and_reveal_step_up(pool: PgPool) {
    let (priv_pem, pub_pem) = gen_keys();
    let mut fx = seed_profile_fixture(&pool, &priv_pem, &pub_pem).await;
    let app = app_router(role_pool(&pool, "console_rt").await, priv_pem, pub_pem);

    // 1. /api/v1/users/me includes 3 extras; /access/people/{id} omits them.
    let (_, _, me) = call_json(
        app.clone(),
        "GET",
        "/api/v1/users/me",
        Some(&fx.tok_a),
        None,
        &[],
    )
    .await;
    assert_eq!(me["employee_hire_date"], "2024-03-01");
    assert_eq!(me["employee_employment_status"], "ACTIVE");
    assert_eq!(me["employee_grade"], "Senior");
    let (st, _, dir) = call_json(
        app.clone(),
        "GET",
        &format!("/api/v1/access/people/{}", fx.user_a.as_uuid()),
        Some(&fx.tok_admin),
        None,
        &[],
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{dir}");
    assert!(dir.get("employee_grade").is_none());

    // 2. /api/v1/me/profile masked read, unlinked 403, PATCH immediate fields, refuse masked & address.
    assert_eq!(
        call_json(
            app.clone(),
            "GET",
            "/api/v1/me/profile",
            Some(&fx.tok_unlinked),
            None,
            &[],
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (st, _, prof) = call_json(
        app.clone(),
        "GET",
        "/api/v1/me/profile",
        Some(&fx.tok_a),
        None,
        &[],
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{prof}");
    assert_eq!(prof["address_masked"], "Seoul Gangnam Yeoksam");
    assert_eq!(prof["bank_account_registered"], false);
    assert!(prof["phone_masked"].as_str().unwrap().contains("•"));
    assert_eq!(
        call_json(
            app.clone(),
            "PATCH",
            "/api/v1/me/profile",
            Some(&fx.tok_a),
            Some(json!({"phone": "010-••••-5678"})),
            &[],
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        call_json(
            app.clone(),
            "PATCH",
            "/api/v1/me/profile",
            Some(&fx.tok_a),
            Some(json!({"address": "secret"})),
            &[],
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let (st, _, upd) = call_json(
        app.clone(),
        "PATCH",
        "/api/v1/me/profile",
        Some(&fx.tok_a),
        Some(json!({
            "phone": "010-9999-8888",
            "emergency_contacts": [
                {"name": "KimFamily", "relation": "SPOUSE", "phone": "010-1111-2222", "contact_notified": true}
            ]
        })),
        &[],
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{upd}");
    assert_eq!(upd["emergency_contacts_registered"], true);

    // 3. /api/v1/me/profile/reveal: step-up, Cache-Control, self_read exclusion, 429 rate limit.
    let (st, _, b) = call_json(
        app.clone(),
        "POST",
        "/api/v1/me/profile/reveal",
        Some(&fx.tok_a),
        Some(json!({"field": "PHONE"})),
        &[],
    )
    .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    assert_eq!(b["error"]["code"], "step_up_required");
    let (st, _, b) = reveal_with_binding(
        &pool,
        app.clone(),
        &fx.tok_a,
        *fx.user_a.as_uuid(),
        Uuid::new_v4(),
        &mut fx.key,
    )
    .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    assert_eq!(b["error"]["code"], "passkey_step_up_failed");
    let (st, hdrs, rev) = reveal_with_binding(
        &pool,
        app.clone(),
        &fx.tok_a,
        *fx.user_a.as_uuid(),
        fx.emp_a,
        &mut fx.key,
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{rev}");
    assert_eq!(
        hdrs.get(header::CACHE_CONTROL)
            .and_then(|v| v.to_str().ok()),
        Some("private, no-store")
    );
    assert_eq!(rev["value"], "+821099998888");
    let (_, _, access_log) = call_json(
        app.clone(),
        "GET",
        "/api/v1/me/access-log",
        Some(&fx.tok_a),
        None,
        &[],
    )
    .await;
    assert!(
        !access_log["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["action"].as_str().unwrap_or("").contains("self_reveal"))
    );
    let self_audit_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events \
         WHERE org_id = $1 AND actor = $2 AND action = 'employee.self_reveal' \
           AND after_snap->>'self_read' = 'true'",
    )
    .bind(fx.org_a.as_uuid())
    .bind(fx.user_a.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(self_audit_count, 1);

    for _ in 0..30 {
        sqlx::query(
            "INSERT INTO audit_events \
             (id, org_id, actor, action, target_type, target_id, trace_id, span_id, occurred_at) \
             VALUES (gen_random_uuid(), $1, $2, 'employee.self_reveal', 'employee', $3, 't', 's', now())",
        )
        .bind(fx.org_a.as_uuid())
        .bind(fx.user_a.as_uuid())
        .bind(fx.emp_a.to_string())
        .execute(&pool)
        .await
        .unwrap();
    }
    let (st, _, b) = reveal_with_binding(
        &pool,
        app,
        &fx.tok_a,
        *fx.user_a.as_uuid(),
        fx.emp_a,
        &mut fx.key,
    )
    .await;
    assert_eq!(st, StatusCode::TOO_MANY_REQUESTS, "{b}");
    assert_eq!(b["error"]["code"], "reveal_rate_limited");
}
