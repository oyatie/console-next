// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[path = "support/leave_self_service_seed.rs"]
mod seed;
#[path = "support/self_service_harness.rs"]
mod support;

use console_app::{AppConfig, AppRole, AppState, DatabaseDependency, build_router};
use http::StatusCode;
use seed::seed_leave_fixture;
use serde_json::{Value, json};
use sqlx::PgPool;
use support::{call_json, gen_keys, role_pool};
use uuid::Uuid;

fn app_router(pool: PgPool, leave_cmd: PgPool, pub_pem: String) -> axum::Router {
    let cfg = AppConfig::from_pairs([
        ("CONSOLE_APP_ROLE", AppRole::Api.to_string()),
        ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".into()),
        ("CONSOLE_JWT_ISSUER", "console-platform-auth".into()),
        ("CONSOLE_JWT_AUDIENCE", "console-api".into()),
        ("CONSOLE_JWT_PUBLIC_KEY_PEM", pub_pem),
    ])
    .unwrap();
    build_router(
        AppState::new(cfg, DatabaseDependency::Postgres(pool))
            .unwrap()
            .with_leave_command_database(leave_cmd),
    )
}

async fn call(
    app: axum::Router,
    method: &str,
    uri: &str,
    token: &str,
    body: Option<Value>,
    ko: bool,
) -> (StatusCode, Value) {
    let hdr = [("Accept-Language", "ko")];
    let extra = if ko { &hdr[..] } else { &[] };
    let (st, _, json) = call_json(app, method, uri, Some(token), body, extra).await;
    (st, json)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn screen7_leave_guards_overlap_preview_calendar_and_ko_i18n(pool: PgPool) {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();
    let (priv_pem, pub_pem) = gen_keys();
    let fx = seed_leave_fixture(&pool, &priv_pem, &pub_pem).await;
    let app = app_router(
        role_pool(&pool, "console_rt").await,
        role_pool(&pool, "console_leave_cmd").await,
        pub_pem,
    );

    // 1. LSA Art. 60: `reason` rejected -> 422.
    let (st, _) = call(app.clone(), "POST", "/api/v2/leave/requests", &fx.t_a, Some(json!({"idempotency_key": Uuid::new_v4(), "leave_type": "annual", "start_date": "2026-07-06", "end_date": "2026-07-06", "reason": "personal"})), false).await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY);

    // 2. ScheduleCalendar wired: Thu 2026-07-16..Mon 2026-07-20 includes Fri holiday (07-17) + weekend -> 2.0 days resolved!
    let k_cal = Uuid::new_v4();
    let (st, v) = call(app.clone(), "POST", "/api/v2/leave/requests", &fx.t_a, Some(json!({"idempotency_key": k_cal, "leave_type": "annual", "start_date": "2026-07-16", "end_date": "2026-07-20"})), false).await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    assert_eq!(v["charge_state"], "resolved");
    assert_eq!(v["charge_units"], "2.000000");

    // 3. Idempotent replay succeeds even though those dates now overlap! New key overlaps -> 409!
    let (st, replay) = call(app.clone(), "POST", "/api/v2/leave/requests", &fx.t_a, Some(json!({"idempotency_key": k_cal, "leave_type": "annual", "start_date": "2026-07-16", "end_date": "2026-07-20"})), false).await;
    assert_eq!(st, StatusCode::CREATED, "{replay}");
    let (st, ov) = call(app.clone(), "POST", "/api/v2/leave/requests", &fx.t_a, Some(json!({"idempotency_key": Uuid::new_v4(), "leave_type": "annual", "start_date": "2026-07-20", "end_date": "2026-07-20"})), true).await;
    assert_eq!(st, StatusCode::CONFLICT, "{ov}");
    assert_eq!(ov["error"]["code"], "leave_overlapping_request");
    let ov_msg = ov["error"]["message"].as_str().unwrap();
    assert!(!ov_msg.is_empty());
    assert!(!ov_msg.to_ascii_lowercase().contains("sql"));
    assert!(!ov_msg.contains("leave_api"));

    // 4. Half-day AM + PM allowed same date; AM + AM -> 409.
    let (st, _) = call(app.clone(), "POST", "/api/v2/leave/requests", &fx.t_a, Some(json!({"idempotency_key": Uuid::new_v4(), "leave_type": "half_day", "partial_day_period": "am", "start_date": "2026-07-22", "end_date": "2026-07-22"})), false).await;
    assert_eq!(st, StatusCode::CREATED);
    let (st, _) = call(app.clone(), "POST", "/api/v2/leave/requests", &fx.t_a, Some(json!({"idempotency_key": Uuid::new_v4(), "leave_type": "half_day", "partial_day_period": "pm", "start_date": "2026-07-22", "end_date": "2026-07-22"})), false).await;
    assert_eq!(st, StatusCode::CREATED);
    let (st, _) = call(app.clone(), "POST", "/api/v2/leave/requests", &fx.t_a, Some(json!({"idempotency_key": Uuid::new_v4(), "leave_type": "half_day", "partial_day_period": "am", "start_date": "2026-07-22", "end_date": "2026-07-22"})), false).await;
    assert_eq!(st, StatusCode::CONFLICT);

    // 5. Closed period 409 (payroll period_locks) -> unlock reopens!
    let lock_id = Uuid::new_v4();
    sqlx::query("INSERT INTO period_locks (id, org_id, domain, period_start, period_end, reason) VALUES ($1, $2, 'payroll', '2026-08-01', '2026-08-31', 'lock')")
        .bind(lock_id).bind(fx.org_a.as_uuid()).execute(&pool).await.unwrap();
    let (st, cl) = call(app.clone(), "POST", "/api/v2/leave/requests", &fx.t_a, Some(json!({"idempotency_key": Uuid::new_v4(), "leave_type": "annual", "start_date": "2026-08-03", "end_date": "2026-08-03"})), true).await;
    assert_eq!(st, StatusCode::CONFLICT, "{cl}");
    assert_eq!(cl["error"]["code"], "leave_period_closed");
    let cl_msg = cl["error"]["message"].as_str().unwrap();
    assert!(!cl_msg.is_empty());
    assert!(!cl_msg.to_ascii_lowercase().contains("sql"));
    assert!(!cl_msg.contains("leave_api"));
    sqlx::query(
        "UPDATE period_locks SET unlocked_at = now(), unlock_reason = 'reopen' WHERE id = $1",
    )
    .bind(lock_id)
    .execute(&pool)
    .await
    .unwrap();
    let (st, _) = call(app.clone(), "POST", "/api/v2/leave/requests", &fx.t_a, Some(json!({"idempotency_key": Uuid::new_v4(), "leave_type": "annual", "start_date": "2026-08-03", "end_date": "2026-08-03"})), false).await;
    assert_eq!(st, StatusCode::CREATED);

    // 6. team-overlap + approval-preview + unlinked 403 + cross-tenant isolation.
    let (st, _) = call(app.clone(), "POST", "/api/v2/leave/requests", &fx.t_mate, Some(json!({"idempotency_key": Uuid::new_v4(), "leave_type": "annual", "start_date": "2026-07-16", "end_date": "2026-07-16"})), false).await;
    assert_eq!(st, StatusCode::CREATED);
    let (st, to) = call(
        app.clone(),
        "GET",
        "/api/v2/me/leave/team-overlap?start_date=2026-07-16&end_date=2026-07-16",
        &fx.t_a,
        None,
        false,
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{to}");
    assert_eq!(to["org_unit"], "Product");
    assert_eq!(to["out_count"], 1);
    assert_eq!(to["members_out"][0]["name"], "Teammate");
    assert!(to["members_out"][0].get("leave_type").is_none());

    let (st, prev) = call(
        app.clone(),
        "GET",
        "/api/v2/me/leave/approval-preview",
        &fx.t_a,
        None,
        false,
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{prev}");
    assert_eq!(prev["filing_state"], "ready");
    assert_eq!(prev["steps"][0]["approver_name"], "TeamLead");
    let (st, bl) = call(
        app.clone(),
        "GET",
        "/api/v2/me/leave/approval-preview",
        &fx.t_branchless,
        None,
        false,
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{bl}");
    assert_eq!(bl["filing_state"], "home_branch_required");
    assert_eq!(
        call(
            app.clone(),
            "GET",
            "/api/v2/me/leave/team-overlap?start_date=2026-07-16&end_date=2026-07-16",
            &fx.t_unlinked,
            None,
            false
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            app.clone(),
            "GET",
            "/api/v2/me/leave/team-overlap?start_date=2026-07-16&end_date=2026-07-16",
            &fx.t_b,
            None,
            false
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
}
