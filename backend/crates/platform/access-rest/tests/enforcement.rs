#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! The proof that grants reach the existing doors: an account with NO legacy
//! role (AX-0) signs in, and the request context projects its Cedar-allowed
//! grants onto the same `authorize*` doors the HR and org handlers call —
//! inside its 법인, not outside it, not before 운영 시작 unless marked for
//! setup, not after its end date. Ops is logged on every request.

mod support;

use axum::http::{Method, StatusCode};
use console_kernel_core::BranchId;
use console_platform_authz::{Action, Feature, Principal, authorize, authorize_capability};
use console_platform_request_context::resolve_principal_from_bearer_token;
use serde_json::json;
use sqlx::PgPool;
use support::{World, grant_op, world};

async fn principal(w: &World, user: console_kernel_core::UserId) -> Principal {
    let token = w.token(user).await;
    resolve_principal_from_bearer_token(&w.verifier, &w.rt, &token)
        .await
        .unwrap()
}

fn may_edit_people(p: &Principal, branch: uuid::Uuid) -> bool {
    authorize(
        p,
        Action::new(Feature::EmployeeDirectoryManage),
        BranchId::from_uuid(branch),
    )
    .is_ok()
}

fn may_list_people(p: &Principal) -> bool {
    authorize_capability(p, Action::new(Feature::EmployeeDirectoryRead)).is_ok()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_roleless_account_works_only_inside_its_grant_and_only_once_it_counts(pool: PgPool) {
    let mut w = world(pool).await;
    let hr = principal(&w, w.hr).await;
    assert!(hr.roles.is_empty(), "AX-0: no legacy role, still a session");
    assert!(
        !may_edit_people(&hr, w.branch_a) && !may_list_people(&hr),
        "nothing before a grant"
    );

    let role = w
        .role(
            "인사 실무",
            json!([{ "domain": "hr_basic", "levels": ["edit"] }]),
        )
        .await;
    w.grant(json!([grant_op(
        w.hr,
        role,
        "LEGAL_ENTITY",
        Some(w.le_a),
        false
    )]))
    .await;
    let hr = principal(&w, w.hr).await;
    assert!(
        !may_edit_people(&hr, w.branch_a),
        "PREPARED in SETUP: not yet"
    );

    w.go_live().await;
    let hr = principal(&w, w.hr).await;
    assert!(
        may_edit_people(&hr, w.branch_a),
        "법인 A's 사업장, after 운영 시작"
    );
    assert!(
        !may_edit_people(&hr, w.branch_b),
        "법인 B is outside the grant"
    );
    assert!(
        may_list_people(&hr),
        "the list door covers the whole (projected) scope"
    );
    assert!(
        authorize(
            &hr,
            Action::new(Feature::PayrollRunRead),
            BranchId::from_uuid(w.branch_a)
        )
        .is_err(),
        "급여 was never granted"
    );
    assert!(!hr.is_tenant_ops);

    // End it: the end date is the one column a grant lets move.
    sqlx::query("UPDATE access_grants SET valid_to = valid_from + interval '1 microsecond' WHERE account_id = $1")
        .bind(w.hr.as_uuid())
        .execute(&w.owner)
        .await
        .unwrap();
    let hr = principal(&w, w.hr).await;
    assert!(
        !may_edit_people(&hr, w.branch_a) && !may_list_people(&hr),
        "an ended grant authorizes nothing"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_setup_helper_works_in_setup_and_a_workplace_grant_stays_in_its_workplace(pool: PgPool) {
    let mut w = world(pool).await;
    let role = w
        .role(
            "인사 실무",
            json!([{ "domain": "hr_basic", "levels": ["edit"] }]),
        )
        .await;
    w.grant(json!([grant_op(
        w.hr2,
        role,
        "WORKPLACE",
        Some(w.wp_b),
        true
    )]))
    .await;
    let helper = principal(&w, w.hr2).await;
    assert!(may_edit_people(&helper, w.branch_b), "설정 단계부터 적용");
    assert!(!may_edit_people(&helper, w.branch_a));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn every_ops_request_is_logged_and_nobody_else_is(pool: PgPool) {
    let w = world(pool).await;
    let ops = principal(&w, w.ops).await;
    assert!(
        ops.is_tenant_ops && ops.roles.is_empty(),
        "ops is a flag, not a role"
    );
    let (status, _) = w
        .call(Method::GET, "/api/v1/access/roles", w.ops, None)
        .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "ops manages access by the platform policy"
    );
    let (_, _) = w.call(Method::GET, "/api/v1/access/me", w.hr, None).await;
    let rows: Vec<(uuid::Uuid, String)> = sqlx::query_as(
        "SELECT account_id, method FROM access_ops_usage WHERE org_id = $1 ORDER BY at",
    )
    .bind(w.org)
    .fetch_all(&w.owner)
    .await
    .unwrap();
    assert_eq!(
        rows.len(),
        2,
        "one per resolved ops request (the direct resolve and the HTTP call)"
    );
    assert!(rows.iter().all(|(a, _)| a == w.ops.as_uuid()));
    let (status, usage) = w
        .call(Method::GET, "/api/v1/access/ops-usage", w.ops, None)
        .await;
    assert_eq!(status, StatusCode::OK, "{usage}");
    assert!(usage.as_array().unwrap().len() >= 2);
    let (status, _) = w
        .call(Method::GET, "/api/v1/access/ops-usage", w.hr, None)
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (_, holder) = w.call(Method::GET, "/api/v1/access/ops", w.ops, None).await;
    assert_eq!(holder["account_id"], json!(w.ops.as_uuid()));
}
