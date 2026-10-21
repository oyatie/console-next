//! Each ATT-S1 schedule body refuses a field it does not know: 422 `body_invalid` and
//! nothing written. The same body without that field then succeeds, so the refusal is
//! the unknown field's and nothing else's.

use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;

use super::http_support::{Ctx, ctx, employee_body, structure, tenant, today_kst};

struct World {
    admin: Ctx,
    pool: PgPool,
    workplace: String,
    person: String,
    pattern: String,
    crew: String,
    holiday: String,
    layer: String,
    /// Next year: every date the bodies name is in the future.
    year: i32,
}

async fn schedule_rows(pool: &PgPool) -> Value {
    sqlx::query_scalar(
        "SELECT jsonb_build_array(\
         (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id), '[]') FROM attendance_work_patterns t),\
         (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id), '[]') FROM attendance_crews t),\
         (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t::text), '[]') FROM attendance_crew_members t),\
         (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id), '[]') FROM attendance_schedule_layers t),\
         (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id), '[]') FROM attendance_contractual_holidays t))",
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn created(admin: &Ctx, path: &str, body: Value) -> Value {
    let (status, out) = admin.call("POST", path, Some(body)).await;
    assert!(status.is_success(), "{path}: {status} {out}");
    out
}

fn pattern_body(name: &str) -> Value {
    let work = json!({"kind": "WORK", "shift": {"start": 540, "end": 1080, "breaks": [{"start": 720, "end": 780}]}});
    json!({"name": name, "kind": "WEEKLY",
        "days": [work, work, work, work, work, {"kind": "REST_DAY"}, {"kind": "WEEKLY_HOLIDAY"}]})
}

fn holiday_body(w: &World) -> Value {
    json!({"name": "창립기념일", "rule_kind": "YEARLY", "month": 10, "day": 9, "paid": true,
        "scope_kind": "WORKPLACE", "scope_id": w.workplace, "basis_kind": "WORK_RULES",
        "basis_ref": "제40조", "start_year": w.year})
}

fn assign_body(w: &World) -> Value {
    json!({"targets": [{"scope_kind": "WORKPLACE", "scope_id": w.workplace}],
        "pattern_id": w.pattern, "effective_from": format!("{}-01-01", w.year), "reason": "STANDARD"})
}

/// A tenant with a 사업장, one person bound to it, and one of each schedule record.
async fn world(pool: PgPool) -> World {
    let (org, owner) = tenant(&pool, &["SUPER_ADMIN"]).await;
    let admin = ctx(&pool, org, owner, &["SUPER_ADMIN"], None).await;
    let (entity, workplace, branch, unit) = structure(&admin).await;
    let hired = created(
        &admin,
        "/api/v1/employees",
        employee_body("S1-U1", &branch, &unit),
    )
    .await;
    let person = hired["employee"]["id"].as_str().unwrap().to_owned();
    created(
        &admin,
        "/api/v1/employment-assignments",
        json!({"employee_id": person,
        "legal_entity_id": entity, "workplace_id": workplace, "valid_from": "2026-01-02"}),
    )
    .await;
    let year = today_kst()[..4].parse::<i32>().unwrap() + 1;
    let mut w = World {
        admin,
        pool,
        workplace,
        person,
        pattern: String::new(),
        crew: String::new(),
        holiday: String::new(),
        layer: String::new(),
        year,
    };
    let id = |v: &Value| v["id"].as_str().unwrap().to_owned();
    w.pattern = id(&created(
        &w.admin,
        "/api/v1/attendance/patterns",
        pattern_body("사무"),
    )
    .await);
    w.crew = id(&created(
        &w.admin,
        "/api/v1/attendance/crews",
        json!({"workplace_id": w.workplace, "name": "A조"}),
    )
    .await);
    w.holiday = id(&created(&w.admin, "/api/v1/attendance/holidays", holiday_body(&w)).await);
    let receipt = created(
        &w.admin,
        "/api/v1/attendance/schedule/layers",
        assign_body(&w),
    )
    .await;
    w.layer = id(&receipt["layers"][0]);
    w
}

async fn refuses_unknown_then_accepts(w: &World, path: &str, body: Value) {
    let before = schedule_rows(&w.pool).await;
    let mut unknown = body.clone();
    unknown["unexpected"] = json!(true);
    let (status, refused) = w.admin.call("POST", path, Some(unknown)).await;
    assert_eq!(
        status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{path}: {refused}"
    );
    assert_eq!(
        refused["error"]["code"], "body_invalid",
        "{path}: {refused}"
    );
    assert_eq!(
        schedule_rows(&w.pool).await,
        before,
        "{path} wrote schedule rows"
    );
    created(&w.admin, path, body).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn pattern_create_refuses_an_unknown_field(pool: PgPool) {
    let w = world(pool).await;
    refuses_unknown_then_accepts(&w, "/api/v1/attendance/patterns", pattern_body("교대 전")).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn layer_preview_refuses_an_unknown_field(pool: PgPool) {
    let w = world(pool).await;
    let body = assign_body(&w);
    refuses_unknown_then_accepts(&w, "/api/v1/attendance/schedule/layers/preview", body).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn layer_assign_refuses_an_unknown_field(pool: PgPool) {
    let w = world(pool).await;
    let mut body = assign_body(&w);
    body["effective_from"] = json!(format!("{}-02-01", w.year));
    refuses_unknown_then_accepts(&w, "/api/v1/attendance/schedule/layers", body).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn layer_cancel_refuses_an_unknown_field(pool: PgPool) {
    let w = world(pool).await;
    let path = format!("/api/v1/attendance/schedule/layers/{}/cancel", w.layer);
    refuses_unknown_then_accepts(&w, &path, json!({"reason": "잘못 배정"})).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn crew_create_refuses_an_unknown_field(pool: PgPool) {
    let w = world(pool).await;
    let body = json!({"workplace_id": w.workplace, "name": "B조"});
    refuses_unknown_then_accepts(&w, "/api/v1/attendance/crews", body).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn crew_members_refuse_an_unknown_field(pool: PgPool) {
    let w = world(pool).await;
    let path = format!("/api/v1/attendance/crews/{}/members", w.crew);
    let body = json!({"employee_ids": [w.person], "valid_from": "2026-01-02"});
    refuses_unknown_then_accepts(&w, &path, body).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn holiday_preview_refuses_an_unknown_field(pool: PgPool) {
    let w = world(pool).await;
    let body = holiday_body(&w);
    refuses_unknown_then_accepts(&w, "/api/v1/attendance/holidays/preview", body).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn holiday_create_refuses_an_unknown_field(pool: PgPool) {
    let w = world(pool).await;
    let mut body = holiday_body(&w);
    body["name"] = json!("노조창립일");
    body["day"] = json!(20);
    refuses_unknown_then_accepts(&w, "/api/v1/attendance/holidays", body).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn holiday_retire_refuses_an_unknown_field(pool: PgPool) {
    let w = world(pool).await;
    let path = format!("/api/v1/attendance/holidays/{}/retire", w.holiday);
    refuses_unknown_then_accepts(&w, &path, json!({"from_year": w.year})).await;
}
