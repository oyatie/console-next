#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Grants over HTTP: preview receipts and step-up apply, the SETUP / 운영 시작
//! switch, dating, the grantor ceiling and every per-item refusal.

mod support;

use axum::http::{Method, StatusCode};
use serde_json::{Value, json};
use sqlx::PgPool;
use support::{World, grant_op, world};

async fn preview(w: &World, actor: console_kernel_core::UserId, ops: Value) -> Value {
    let body = json!({ "reason_code": "PROMOTION_OR_REASSIGNMENT", "operations": ops });
    let (status, out) = w
        .call(
            Method::POST,
            "/api/v1/access/grants/preview",
            actor,
            Some(body),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{out}");
    out
}

fn refusal(preview: &Value, i: usize) -> Value {
    preview["items"][i]["refusal"]["code"].clone()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_grant_is_prepared_in_setup_and_enforced_from_go_live_unless_marked_for_setup(
    pool: PgPool,
) {
    let mut w = world(pool).await;
    let role = w
        .role(
            "인사 실무",
            json!([{ "domain": "hr_basic", "levels": ["edit"] }]),
        )
        .await;
    let p = preview(
        &w,
        w.ops,
        json!([grant_op(w.hr, role, "LEGAL_ENTITY", Some(w.le_a), false)]),
    )
    .await;
    assert_eq!(
        (p["phase"].clone(), p["step_up_required"].clone()),
        (json!("SETUP"), json!(true))
    );
    assert_eq!(p["items"][0]["enforcement_after"], "PREPARED");
    assert_eq!(
        p["items"][0]["gains"],
        json!([]),
        "a prepared grant gains nothing yet"
    );
    let applied = w
        .grant(json!([grant_op(
            w.hr,
            role,
            "LEGAL_ENTITY",
            Some(w.le_a),
            false
        )]))
        .await;
    assert_eq!(applied[0]["enforcement"], "PREPARED");
    assert_eq!(applied[0]["change_mode"], Value::Null, "not a wire field");
    let helper = w
        .grant(json!([grant_op(
            w.hr2,
            role,
            "WORKPLACE",
            Some(w.wp_b),
            true
        )]))
        .await;
    assert_eq!(helper[0]["enforcement"], "ENFORCED", "설정 단계부터 적용");

    let (_, me) = w.call(Method::GET, "/api/v1/access/me", w.hr, None).await;
    let states: Vec<&Value> = me["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| &e["enforcement"])
        .collect();
    assert!(states.iter().all(|s| *s == "PREPARED"), "{me}");
    w.go_live().await;
    let (_, me) = w.call(Method::GET, "/api/v1/access/me", w.hr, None).await;
    assert_eq!(me["phase"], "OPERATING");
    let edit = me["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["level"] == "edit")
        .unwrap();
    assert_eq!(edit["enforcement"], "ENFORCED", "{me}");
    assert_eq!(
        edit["scope"],
        json!({ "kind": "LEGAL_ENTITY", "node_id": w.le_a, "include_descendants": true })
    );
    let (status, theirs) = w
        .call(
            Method::GET,
            &format!("/api/v1/access/accounts/{}/effective", w.hr.as_uuid()),
            w.ops,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(theirs["entries"], me["entries"]);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn every_per_item_refusal_comes_back_in_the_preview(pool: PgPool) {
    let mut w = world(pool).await;
    let role = w
        .role(
            "조직 조회",
            json!([{ "domain": "org", "levels": ["view"] }]),
        )
        .await;
    w.grant(json!([grant_op(w.hr, role, "TENANT", None, true)]))
        .await;
    let mut dept = grant_op(w.hr2, role, "DEPARTMENT", Some(uuid::Uuid::new_v4()), true);
    let mut exact = grant_op(w.hr2, role, "WORKPLACE", Some(w.wp_a), true);
    exact["scope"]["include_descendants"] = json!(false);
    let mut backwards = grant_op(w.hr2, role, "WORKPLACE", Some(w.wp_a), true);
    backwards["valid_to"] = json!("2020-01-01T00:00:00Z");
    let p = preview(
        &w,
        w.ops,
        json!([
            grant_op(w.ops, role, "TENANT", None, true),
            grant_op(w.hr, role, "TENANT", None, true),
            dept.take(),
            exact,
            grant_op(w.hr2, role, "LEGAL_ENTITY", Some(uuid::Uuid::new_v4()), true),
            backwards,
            grant_op(w.hr2, role, "WORKPLACE", Some(w.wp_a), true),
            grant_op(w.hr2, role, "WORKPLACE", Some(w.wp_a), true),
            { "op": "revoke", "grant_id": uuid::Uuid::new_v4() },
        ]),
    )
    .await;
    let codes: Vec<Value> = (0..9).map(|i| refusal(&p, i)).collect();
    assert_eq!(
        codes,
        vec![
            json!("grant_target_is_ops"),
            json!("grant_overlap"),
            // AX-5: a 부서 is a scope now; this one does not exist.
            json!("scope_node_not_found"),
            json!("scope_not_enforceable_in_pilot"),
            json!("scope_node_not_found"),
            json!("valid_range_invalid"),
            Value::Null,
            json!("duplicate_operation"),
            json!("grant_not_found"),
        ]
    );
    assert_eq!(p["refused"], 8);
    let step_up = w.ops_key.step_up(&w.owner).await;
    let apply = json!({ "receipt_id": p["receipt_id"], "step_up": step_up });
    let (status, body) = w
        .call(
            Method::POST,
            "/api/v1/access/grants/apply",
            w.ops,
            Some(apply),
        )
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::CONFLICT, json!("preview_has_refusals"))
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn apply_needs_a_step_up_and_a_receipt_is_used_once(pool: PgPool) {
    let mut w = world(pool).await;
    let role = w
        .role(
            "조직 조회",
            json!([{ "domain": "org", "levels": ["view"] }]),
        )
        .await;
    let p = preview(
        &w,
        w.ops,
        json!([grant_op(w.hr, role, "TENANT", None, true)]),
    )
    .await;
    let (status, body) = w
        .call(
            Method::POST,
            "/api/v1/access/grants/apply",
            w.ops,
            Some(json!({ "receipt_id": p["receipt_id"] })),
        )
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (
            StatusCode::PRECONDITION_REQUIRED,
            json!("passkey_step_up_required")
        )
    );
    let apply =
        json!({ "receipt_id": p["receipt_id"], "step_up": w.ops_key.step_up(&w.owner).await });
    let (status, body) = w
        .call(
            Method::POST,
            "/api/v1/access/grants/apply",
            w.ops,
            Some(apply),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let again =
        json!({ "receipt_id": p["receipt_id"], "step_up": w.ops_key.step_up(&w.owner).await });
    let (status, body) = w
        .call(
            Method::POST,
            "/api/v1/access/grants/apply",
            w.ops,
            Some(again),
        )
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::CONFLICT, json!("receipt_used"))
    );
    let ledger: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM authz_grant_ledger WHERE grant_kind = 'ACCESS_GRANT' AND event = 'GRANTED' AND user_id = $1",
    )
    .bind(w.hr.as_uuid())
    .fetch_one(&w.owner)
    .await
    .unwrap();
    assert_eq!(ledger, 1, "the grant is in the 3-year ledger");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_preview_that_went_stale_is_refused_at_apply(pool: PgPool) {
    let mut w = world(pool).await;
    let role = w
        .role(
            "조직 조회",
            json!([{ "domain": "org", "levels": ["view"] }]),
        )
        .await;
    let p = preview(
        &w,
        w.ops,
        json!([grant_op(w.hr, role, "TENANT", None, true)]),
    )
    .await;
    w.grant(json!([grant_op(w.hr, role, "TENANT", None, true)]))
        .await;
    let apply =
        json!({ "receipt_id": p["receipt_id"], "step_up": w.ops_key.step_up(&w.owner).await });
    let (status, body) = w
        .call(
            Method::POST,
            "/api/v1/access/grants/apply",
            w.ops,
            Some(apply),
        )
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::CONFLICT, json!("preview_stale"))
    );
}
