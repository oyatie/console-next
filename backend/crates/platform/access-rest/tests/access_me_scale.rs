// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! `/access/me` decides tenant commands without loading the tenant's org tree.
mod support;

use axum::http::{Method, StatusCode};
use serde_json::json;
use sqlx::PgPool;
use support::{grant_op, world};
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

        let queries = trail_queries::Queries::default();
        let (status, me) = w
            .call(Method::GET, "/api/v1/access/me", w.hr, None)
            .with_subscriber(queries.clone())
            .await;
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
