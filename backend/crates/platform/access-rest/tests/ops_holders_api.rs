// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Live Postgres HTTP verification for at-most-two ops account holder invariants
//! and self-only holder release under `console_rt` (`FORCE RLS`).

mod support;

use axum::http::{Method, StatusCode};
use console_kernel_core::OrgId;
use console_platform_test_support::soft_passkey::SoftKey;
use serde_json::json;
use sqlx::PgPool;
use support::{grant_op, world};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn ops_holders_enforce_two_holder_cap_zero_grants_and_self_only_release(pool: PgPool) {
    let mut w = world(pool).await;

    let (st, initial) = w.call(Method::GET, "/api/v1/access/ops", w.ops, None).await;
    assert_eq!(st, StatusCode::OK, "{initial}");
    assert_eq!(initial["max_holders"], 2);
    assert_eq!(initial["holders"].as_array().unwrap().len(), 1);

    let hr_step = w.hr_key.step_up(&w.owner).await;
    let (st, denied) = w
        .call(
            Method::POST,
            "/api/v1/access/ops/holders",
            w.hr,
            Some(json!({ "account_id": w.hr2.as_uuid(), "step_up": hr_step })),
        )
        .await;
    assert_eq!(st, StatusCode::FORBIDDEN, "{denied}");

    let step = w.ops_key.step_up(&w.owner).await;
    let (st, no_pk) = w
        .call(
            Method::POST,
            "/api/v1/access/ops/holders",
            w.ops,
            Some(json!({ "account_id": w.hr2.as_uuid(), "step_up": step })),
        )
        .await;
    assert_eq!(
        (st, no_pk["error"]["code"].clone()),
        (StatusCode::CONFLICT, json!("ops_candidate_needs_passkey"))
    );

    let role = w
        .role(
            "HR Viewer",
            json!([{ "domain": "hr_basic", "levels": ["view"] }]),
        )
        .await;
    let granted = w
        .grant(json!([grant_op(w.hr, role, "TENANT", None, true)]))
        .await;
    let grant_id = granted[0]["id"].as_str().unwrap();
    let step = w.ops_key.step_up(&w.owner).await;
    let (st, has_grants) = w
        .call(
            Method::POST,
            "/api/v1/access/ops/holders",
            w.ops,
            Some(json!({ "account_id": w.hr.as_uuid(), "step_up": step })),
        )
        .await;
    assert_eq!(
        (st, has_grants["error"]["code"].clone()),
        (StatusCode::CONFLICT, json!("ops_candidate_has_grants"))
    );

    w.grant(json!([{ "op": "revoke", "grant_id": grant_id }]))
        .await;
    let step = w.ops_key.step_up(&w.owner).await;
    let (st, two_holders) = w
        .call(
            Method::POST,
            "/api/v1/access/ops/holders",
            w.ops,
            Some(json!({ "account_id": w.hr.as_uuid(), "step_up": step })),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{two_holders}");
    assert_eq!(two_holders["holders"].as_array().unwrap().len(), 2);

    let _hr2_key = SoftKey::enroll(&w.owner, OrgId::from_uuid(w.org), w.hr2).await;
    let step = w.ops_key.step_up(&w.owner).await;
    let (st, cap) = w
        .call(
            Method::POST,
            "/api/v1/access/ops/holders",
            w.ops,
            Some(json!({ "account_id": w.hr2.as_uuid(), "step_up": step })),
        )
        .await;
    assert_eq!(
        (st, cap["error"]["code"].clone()),
        (StatusCode::CONFLICT, json!("ops_holder_limit_reached"))
    );

    let step = w.ops_key.step_up(&w.owner).await;
    let (st, self_only) = w
        .call(
            Method::POST,
            "/api/v1/access/ops/holders/release",
            w.ops,
            Some(json!({ "target_account_id": w.hr.as_uuid(), "step_up": step })),
        )
        .await;
    assert_eq!(
        (st, self_only["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("ops_release_self_only"))
    );

    // Once `hr` is designated, `w.token(w.hr)` in `World` needs `is_tenant_ops` via DB or fresh principal:
    // Note: `AccessRest` auth middleware loads `is_tenant_ops` from DB for tenant sessions!
    let hr_step = w.hr_key.step_up(&w.owner).await;
    let (st, after_release) = w
        .call(
            Method::POST,
            "/api/v1/access/ops/holders/release",
            w.hr,
            Some(json!({ "reason": "handover complete", "step_up": hr_step })),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{after_release}");
    assert_eq!(after_release["holders"].as_array().unwrap().len(), 1);

    let step = w.ops_key.step_up(&w.owner).await;
    let (st, last_holder) = w
        .call(
            Method::POST,
            "/api/v1/access/ops/holders/release",
            w.ops,
            Some(json!({ "reason": "cannot leave zero", "step_up": step })),
        )
        .await;
    assert_eq!(
        (st, last_holder["error"]["code"].clone()),
        (StatusCode::CONFLICT, json!("last_ops_holder"))
    );
}
