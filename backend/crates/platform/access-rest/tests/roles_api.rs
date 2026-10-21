#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Role CRUD over HTTP, as the ops account and as an account with nothing:
//! versions, normalization, refusals, and a held role's edit lane.

mod support;

use axum::http::{Method, StatusCode};
use serde_json::json;
use sqlx::PgPool;
use support::{grant_op, world};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn ops_creates_edits_versions_and_deletes_drafts_with_no_legacy_role(pool: PgPool) {
    let w = world(pool).await;
    let lines = json!([{ "domain": "hr_basic", "levels": ["edit"] }, { "domain": "org", "levels": ["view"] }]);
    let (status, role) = w
        .call(
            Method::POST,
            "/api/v1/access/roles",
            w.ops,
            Some(json!({ "name_ko": "인사 실무", "lines": lines })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{role}");
    assert_eq!(role["status"], "ACTIVE");
    assert_eq!(role["version"], 1);
    assert_eq!(
        role["lines"][0],
        json!({ "domain": "org", "levels": ["view"] })
    );
    assert_eq!(
        role["lines"][1],
        json!({ "domain": "hr_basic", "levels": ["view", "edit"] }),
        "edit implies view"
    );
    let audited: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE action = 'access.role.create' AND target_id = $1 AND org_id = $2",
    )
    .bind(role["id"].as_str().unwrap())
    .bind(w.org)
    .fetch_one(&w.owner)
    .await
    .unwrap();
    assert_eq!(audited, 1, "every role write keeps its audit row");
    let id = role["id"].as_str().unwrap();

    let patch = json!({ "expected_version": 1, "description": "직원 등록", "lines": [{ "domain": "org", "levels": ["view"] }] });
    let (status, v2) = w
        .call(
            Method::PATCH,
            &format!("/api/v1/access/roles/{id}"),
            w.ops,
            Some(patch.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{v2}");
    assert_eq!(v2["version"], 2);
    assert_eq!(v2["holders_affected"], json!([]), "no holder, no step-up");
    let (status, stale) = w
        .call(
            Method::PATCH,
            &format!("/api/v1/access/roles/{id}"),
            w.ops,
            Some(patch),
        )
        .await;
    assert_eq!(
        (status, stale["error"]["code"].clone()),
        (StatusCode::CONFLICT, json!("stale_revision"))
    );
    assert_eq!(stale["error"]["current_version"], 2);

    let (_, versions) = w
        .call(
            Method::GET,
            &format!("/api/v1/access/roles/{id}/versions"),
            w.ops,
            None,
        )
        .await;
    assert_eq!(versions.as_array().unwrap().len(), 2);
    assert_eq!(
        versions[0]["change_mode"], "SETUP",
        "the tenant is still in SETUP"
    );

    let (status, dup) = w
        .call(
            Method::POST,
            "/api/v1/access/roles",
            w.ops,
            Some(json!({ "name_ko": " 인사 실무 ", "lines": lines })),
        )
        .await;
    assert_eq!(
        (status, dup["error"]["code"].clone()),
        (StatusCode::CONFLICT, json!("role_name_taken"))
    );

    let (status, gone) = w
        .call(
            Method::DELETE,
            &format!("/api/v1/access/roles/{id}?expected_version=2"),
            w.ops,
            None,
        )
        .await;
    assert_eq!(
        (status, gone["error"]["code"].clone()),
        (StatusCode::CONFLICT, json!("role_not_draft"))
    );
    let (status, draft) = w
        .call(
            Method::POST,
            "/api/v1/access/roles",
            w.ops,
            Some(json!({ "name_ko": "초안", "status": "DRAFT", "lines": lines })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let draft = draft["id"].as_str().unwrap();
    let (status, _) = w
        .call(
            Method::DELETE,
            &format!("/api/v1/access/roles/{draft}?expected_version=1"),
            w.ops,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = w
        .call(
            Method::GET,
            &format!("/api/v1/access/roles/{draft}"),
            w.ops,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn lines_outside_the_catalog_are_refused_with_their_codes(pool: PgPool) {
    let w = world(pool).await;
    for (lines, code) in [
        (json!([]), "lines_empty"),
        (
            json!([{ "domain": "payroll", "levels": ["view"] }]),
            "domain_unknown",
        ),
        (
            json!([{ "domain": "discipline", "levels": ["view"] }]),
            "domain_not_grantable",
        ),
        (
            json!([{ "domain": "bank", "levels": ["approve"] }]),
            "level_not_offered",
        ),
        (
            json!([{ "domain": "org", "levels": ["view"] }, { "domain": "org", "levels": ["edit"] }]),
            "duplicate_domain_line",
        ),
    ] {
        let (status, body) = w
            .call(
                Method::POST,
                "/api/v1/access/roles",
                w.ops,
                Some(json!({ "name_ko": "x", "lines": lines })),
            )
            .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(body["error"]["code"], code);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_account_with_no_grant_sees_only_the_catalog_and_itself(pool: PgPool) {
    let w = world(pool).await;
    let (status, body) = w
        .call(Method::GET, "/api/v1/access/roles", w.hr, None)
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("access_denied"))
    );
    let (status, _) = w
        .call(
            Method::POST,
            "/api/v1/access/roles",
            w.hr,
            Some(json!({ "name_ko": "x", "lines": [{ "domain": "org", "levels": ["view"] }] })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, catalog) = w
        .call(Method::GET, "/api/v1/access/catalog", w.hr, None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(catalog["reason_domain"], "role_change");
    let (status, me) = w.call(Method::GET, "/api/v1/access/me", w.hr, None).await;
    assert_eq!(status, StatusCode::OK, "{me}");
    assert_eq!(
        (me["is_ops"].clone(), me["entries"].clone()),
        (json!(false), json!([]))
    );
    let (_, ops_me) = w.call(Method::GET, "/api/v1/access/me", w.ops, None).await;
    assert_eq!(ops_me["is_ops"], true);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_held_role_changes_only_with_a_reason_and_a_step_up_and_retires_only_when_unheld(
    pool: PgPool,
) {
    let mut w = world(pool).await;
    let role = w
        .role(
            "근태 담당",
            json!([{ "domain": "attendance", "levels": ["edit"] }]),
        )
        .await;
    let granted = w
        .grant(json!([grant_op(
            w.hr,
            role,
            "LEGAL_ENTITY",
            Some(w.le_a),
            true
        )]))
        .await;
    let grant_id = granted[0]["id"].as_str().unwrap().to_owned();
    let uri = format!("/api/v1/access/roles/{role}");
    let widen = json!({ "expected_version": 1, "lines": [{ "domain": "attendance", "levels": ["edit", "approve"] }] });
    let (status, body) = w
        .call(Method::PATCH, &uri, w.ops, Some(widen.clone()))
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            json!("reason_code_invalid")
        )
    );
    let mut with_reason = widen.clone();
    with_reason["reason_code"] = json!("ERROR_CORRECTION");
    let (status, body) = w
        .call(Method::PATCH, &uri, w.ops, Some(with_reason.clone()))
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (
            StatusCode::PRECONDITION_REQUIRED,
            json!("passkey_step_up_required")
        )
    );
    with_reason["step_up"] = w.ops_key.step_up(&w.owner).await;
    let (status, body) = w.call(Method::PATCH, &uri, w.ops, Some(with_reason)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["holders_affected"], json!([w.hr.as_uuid()]));

    let retire =
        json!({ "expected_version": 2, "status": "RETIRED", "reason_code": "ACCESS_CLEANUP" });
    let (status, body) = w
        .call(
            Method::POST,
            &format!("{uri}/status"),
            w.ops,
            Some(retire.clone()),
        )
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::CONFLICT, json!("role_has_active_grants"))
    );
    w.grant(json!([{ "op": "revoke", "grant_id": grant_id }]))
        .await;
    let (status, body) = w
        .call(Method::POST, &format!("{uri}/status"), w.ops, Some(retire))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "RETIRED");
    let (status, body) = w
        .grant_as(w.ops, json!([grant_op(w.hr, role, "TENANT", None, true)]))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["items"][0]["refusal"]["code"], "role_not_active");
}
