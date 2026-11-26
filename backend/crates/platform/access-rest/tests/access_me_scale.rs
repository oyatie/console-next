// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! `/access/me` decides tenant commands without loading the tenant's org tree.
mod support;

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use console_platform_access_rest::ACCESS_ME_PATH;
use console_platform_test_support::json_response::json_response;
use serde_json::json;
use sqlx::PgPool;
use support::{grant_op, world};
use tower::ServiceExt;
use tracing::instrument::WithSubscriber;

#[path = "../../../hr/adapter-postgres/tests/support/trail_queries.rs"]
#[allow(dead_code)]
mod trail_queries;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn access_me_decision_does_not_scan_the_org_tree_at_two_thousand_employees(pool: PgPool) {
    let mut counts = Vec::new();
    for employees in [2, 2_000] {
        let mut w = world(pool.clone()).await;
        let role = w
            .role(
                "인사 실무",
                json!([{ "domain": "hr_basic", "levels": ["edit"] }]),
            )
            .await;
        w.grant(json!([grant_op(w.hr, role, "TENANT", None, true)]))
            .await;
        sqlx::query(
            "INSERT INTO employees (org_id, company, name, source_filename, source_sheet, source_row, source_key) \
             SELECT $1, '회사', '직원 ' || n, 'console', 'console', n, n::text \
             FROM generate_series(1, $2::int) n",
        )
        .bind(w.org)
        .bind(employees)
        .execute(&pool)
        .await
        .unwrap();

        let token = w.token(w.hr).await;
        let request = Request::get(ACCESS_ME_PATH)
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        // Each new runtime connection runs SET ROLE. Finish that setup outside the observer.
        let mut connections = Vec::new();
        for _ in 0..w.rt.options().get_max_connections() {
            connections.push(w.rt.acquire().await.unwrap());
        }
        drop(connections);
        let queries = trail_queries::Queries::default();
        let response = w
            .router()
            .oneshot(request)
            .with_subscriber(queries.clone())
            .await
            .unwrap();
        let (status, me) = json_response(response).await;
        assert_eq!(status, StatusCode::OK, "{me}");
        assert_eq!(me["decisions"]["bulk_appointment"], true, "{me}");
        let statements = queries.statements();
        assert!(
            !statements.is_empty(),
            "SQL observer must record /access/me"
        );
        assert!(
            statements.iter().all(|statement| {
                !statement.contains("SELECT id FROM legal_entities")
                    && !statement.contains("SELECT id, legal_entity_id FROM workplaces")
                    && !statement.contains("WITH RECURSIVE heads AS")
            }),
            "/access/me loaded the org tree: {statements:#?}"
        );
        counts.push(statements.len());
    }
    assert_eq!(
        counts,
        vec![counts[0]; 2],
        "/access/me SQL count must stay flat at 2 and 2,000 employees"
    );
}
