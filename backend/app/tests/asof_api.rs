#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Temporal refusals: stable status/code, no business writes, and a refusal audit.
use http::StatusCode;
use sqlx::PgPool;
#[path = "support/http.rs"]
mod support;
use support::{count, ctx, structure, tenant};
const ADMIN: &[&str] = &["SUPER_ADMIN"];

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn invalid_asof_known_at_and_reversed_compare_are_audited_without_business_writes(
    pool: PgPool,
) {
    let (org, user) = tenant(&pool, ADMIN).await;
    let c = ctx(&pool, org, user, ADMIN, None).await;
    let (entity, workplace, _, _) = structure(&c).await;
    let paths = vec![
        "/api/v1/legal-entities?as_of=2026-02-30".into(),
        format!("/api/v1/legal-entities/{entity}?known_at=tomorrow"),
        format!("/api/v1/workplaces/{workplace}?as_of=2026-13-01"),
        format!("/api/v1/legal-entities/{entity}/workplaces?as_of=bad"),
        "/api/v1/org-structure?known_at=bad".into(),
        "/api/v1/org-structure/diff?a=2026-04-02&b=2026-04-01".into(),
        "/api/v1/org-structure/change-dates?from=2026-04-02&to=2026-04-01".into(),
    ];
    let tables = [
        "legal_entity_revisions",
        "workplace_revisions",
        "org_unit_revisions",
        "employment_assignments",
        "entity_commands",
        "org_change_requests",
    ];
    let mut before = Vec::new();
    for table in tables {
        before.push(count(&pool, table, org).await);
    }
    let audits = count(&pool, "audit_events", org).await;
    for path in &paths {
        let (status, body) = c.call("GET", path, None).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{path}: {body}");
        assert_eq!(body["error"]["code"], "validation_failed");
        assert!(
            body["error"]["errors"]
                .as_array()
                .unwrap()
                .iter()
                .any(|f| f["code"] == "date_invalid")
        );
    }
    for (i, table) in tables.into_iter().enumerate() {
        assert_eq!(count(&pool, table, org).await, before[i], "{table}");
    }
    assert_eq!(
        count(&pool, "audit_events", org).await,
        audits + paths.len() as i64
    );
    let recorded:i64=sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='entity.temporal_read_refused' AND after_snap->>'code'='validation_failed'")
        .bind(org).fetch_one(&pool).await.unwrap();
    assert_eq!(recorded, paths.len() as i64);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn orgchange_invalid_effective_filters_refuse_validation_and_record_the_refusal(
    pool: PgPool,
) {
    let (org, user) = tenant(&pool, ADMIN).await;
    let c = ctx(&pool, org, user, ADMIN, None).await;
    let before = count(&pool, "org_change_requests", org).await;
    for query in [
        "effective_from=bad",
        "effective_to=2026-02-30",
        "effective_from=2026-04-02&effective_to=2026-04-01",
    ] {
        let (status, body) = c
            .call("GET", &format!("/api/v1/org-changes?{query}"), None)
            .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(body["error"]["code"], "validation");
    }
    assert_eq!(count(&pool, "org_change_requests", org).await, before);
    let recorded:i64=sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='org_change.date_filter_refused' AND after_snap->>'code'='validation'")
        .bind(org).fetch_one(&pool).await.unwrap();
    assert_eq!(recorded, 3);
}
