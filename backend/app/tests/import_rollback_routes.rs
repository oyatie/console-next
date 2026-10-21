// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
//! Run-history routes must be mounted behind authentication and org-wide HR authorization.

use http::StatusCode;
use sqlx::PgPool;
use uuid::Uuid;

#[path = "emp_ui_routes/harness.rs"]
mod harness;
use harness::{Caller, keys, router, token, user};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn run_history_routes_are_authenticated_and_hide_unknown_runs(pool: PgPool) {
    let org = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'Import rollback test')",
    )
    .bind(org)
    .bind(format!("rollback-{org}"))
    .execute(&pool)
    .await
    .unwrap();
    let keys = keys();
    let service = router(&pool, &keys).await;
    let ops_id = user(&pool, org, "SUPER_ADMIN").await;
    let member_id = user(&pool, org, "MEMBER").await;
    let ops = Caller {
        service: service.clone(),
        token: Some(token(&pool, &keys, org, ops_id, "SUPER_ADMIN").await),
    };
    let member = Caller {
        service: service.clone(),
        token: Some(token(&pool, &keys, org, member_id, "MEMBER").await),
    };
    let anonymous = Caller {
        service,
        token: None,
    };
    let list = "/api/v1/employee-import-runs";
    let record = format!("{list}/{}", Uuid::new_v4());
    for path in [list, &record] {
        assert_eq!(
            anonymous.call("GET", path, None).await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            member.call("GET", path, None).await.0,
            StatusCode::FORBIDDEN
        );
    }
    let (status, body) = ops.call("GET", list, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["items"], serde_json::json!([]));
    let (status, body) = ops.call("GET", &record, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["error"]["code"], "import_run_not_found");
}
