// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Pin the server projection consumed by the console's route guard.
mod support;

use std::sync::{Arc, Mutex};

use axum::http::{Method, StatusCode};
use serde_json::json;
use sqlx::PgPool;
use support::{grant_op, world};
use tracing::{
    Event, Metadata, Subscriber,
    field::{Field, Visit},
    instrument::WithSubscriber,
    span::{Attributes, Id, Record},
};

#[derive(Clone, Default)]
struct Events(Arc<Mutex<Vec<String>>>);
struct Fields(String);
impl Visit for Fields {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.0.push_str(&format!("{}={value:?} ", field.name()));
    }
}
impl Subscriber for Events {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        metadata.target() == "console_platform_access::effective"
    }
    fn new_span(&self, _: &Attributes<'_>) -> Id {
        Id::from_u64(1)
    }
    fn record(&self, _: &Id, _: &Record<'_>) {}
    fn record_follows_from(&self, _: &Id, _: &Id) {}
    fn enter(&self, _: &Id) {}
    fn exit(&self, _: &Id) {}
    fn event(&self, event: &Event<'_>) {
        let mut fields = Fields(String::new());
        event.record(&mut fields);
        self.0.lock().unwrap().push(fields.0);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn invalid_cedar_decision_logs_the_request_support_reference_and_stays_closed(pool: PgPool) {
    let mut w = world(pool).await;
    let role = w
        .role(
            "broken role",
            json!([{ "domain": "hr_basic", "levels": ["edit"] }]),
        )
        .await;
    w.grant(json!([grant_op(w.hr, role, "TENANT", None, true)]))
        .await;
    sqlx::query("INSERT INTO access_role_lines(org_id,role_id,version,domain,levels) VALUES($1,$2,1,'sensitive',ARRAY['approve'])")
        .bind(w.org).bind(role).execute(&w.owner).await.unwrap();
    const TRACE_ID: &str = "4bf92f3577b34da6a3ce929d0e0e4736";
    let events = Events::default();
    let (status, me) = w
        .call_with_trace(
            Method::GET,
            "/api/v1/access/me",
            w.hr,
            None,
            &format!("00-{TRACE_ID}-00f067aa0ba902b7-01"),
        )
        .with_subscriber(events.clone())
        .await;
    assert_eq!(status, StatusCode::OK, "{me}");
    assert_eq!(me["decisions"], json!({}), "{me}");
    let events = events.0.lock().unwrap().join("\n");
    assert!(
        events.contains("Cedar access decision failed closed"),
        "{events}"
    );
    assert!(events.contains(TRACE_ID), "{events}");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn bulk_appointment_decision_uses_live_tenant_grants_of_either_domain(pool: PgPool) {
    for domain in ["hr_basic", "appointment"] {
        let mut w = world(pool.clone()).await;
        let role = w
            .role(domain, json!([{ "domain": domain, "levels": ["edit"] }]))
            .await;
        for (scope, node, in_setup, allowed) in [
            ("LEGAL_ENTITY", Some(w.le_a), true, false),
            ("TENANT", None, false, false),
            ("TENANT", None, true, true),
        ] {
            w.grant(json!([grant_op(w.hr, role, scope, node, in_setup)]))
                .await;
            let (status, me) = w.call(Method::GET, "/api/v1/access/me", w.hr, None).await;
            assert_eq!(status, StatusCode::OK, "{me}");
            assert_eq!(
                me["decisions"]["bulk_appointment"], allowed,
                "{domain}: {me}"
            );
            let (status, effective) = w
                .call(
                    Method::GET,
                    &format!("/api/v1/access/accounts/{}/effective", w.hr.as_uuid()),
                    w.ops,
                    None,
                )
                .await;
            assert_eq!(status, StatusCode::OK, "{effective}");
            assert_eq!(
                effective["decisions"]["bulk_appointment"], allowed,
                "{domain}: {effective}"
            );
            sqlx::query("UPDATE access_grants SET status = 'REVOKED', revoked_at = now(), revoked_by = $3 WHERE org_id = $1 AND account_id = $2 AND status <> 'REVOKED'")
                .bind(w.org).bind(w.hr.as_uuid()).bind(w.ops.as_uuid()).execute(&w.owner).await.unwrap();
            let (_, revoked) = w.call(Method::GET, "/api/v1/access/me", w.hr, None).await;
            assert_eq!(revoked["decisions"]["bulk_appointment"], false, "{revoked}");
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn inactive_account_has_no_projected_command_decisions(pool: PgPool) {
    let mut w = world(pool).await;
    let role = w
        .role(
            "인사 실무",
            json!([{ "domain": "hr_basic", "levels": ["edit"] }]),
        )
        .await;
    w.grant(json!([grant_op(w.hr, role, "TENANT", None, true)]))
        .await;
    sqlx::query("UPDATE users SET is_active = false WHERE org_id = $1 AND id = $2")
        .bind(w.org)
        .bind(w.hr.as_uuid())
        .execute(&w.owner)
        .await
        .unwrap();

    let (status, effective) = w
        .call(
            Method::GET,
            &format!("/api/v1/access/accounts/{}/effective", w.hr.as_uuid()),
            w.ops,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{effective}");
    assert_eq!(effective["decisions"], json!({}), "{effective}");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn route_refusal_and_implied_view_are_server_decisions(pool: PgPool) {
    let mut w = world(pool).await;
    for path in [
        "/api/v1/access/roles".to_owned(),
        "/api/v1/access/grants".to_owned(),
        format!("/api/v1/access/accounts/{}/effective", w.hr.as_uuid()),
    ] {
        let (status, body) = w.call(Method::GET, &path, w.hr, None).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{path}: {body}");
        assert_eq!(body["error"]["code"], "access_denied", "{body}");
    }
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
        true
    )]))
    .await;
    let (status, me) = w.call(Method::GET, "/api/v1/access/me", w.hr, None).await;
    assert_eq!(status, StatusCode::OK, "{me}");
    let entries = me["entries"].as_array().unwrap();
    assert_eq!(
        entries.len(),
        2,
        "edit is normalized to view and edit: {me}"
    );
    for level in ["view", "edit"] {
        let entry = entries.iter().find(|e| e["level"] == level).unwrap();
        assert_eq!(entry["domain"], "hr_basic");
        assert_eq!(entry["enforcement"], "ENFORCED", "{entry}");
        assert_eq!(entry["scope"]["kind"], "LEGAL_ENTITY");
        assert_eq!(entry["scope"]["node_id"], w.le_a.to_string());
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn single_domain_readers_keep_their_distinct_effective_permissions(pool: PgPool) {
    let mut w = world(pool).await;
    for (account, domain, level, expected_status) in [
        (w.hr, "hr_basic", "view", StatusCode::FORBIDDEN),
        (w.hr2, "access", "edit", StatusCode::OK),
    ] {
        let role = w
            .role(domain, json!([{ "domain": domain, "levels": [level] }]))
            .await;
        w.grant(json!([grant_op(account, role, "TENANT", None, true)]))
            .await;
        let (status, me) = w
            .call(Method::GET, "/api/v1/access/me", account, None)
            .await;
        assert_eq!(status, StatusCode::OK, "{me}");
        assert_eq!(me["is_ops"], false);
        let entries = me["entries"].as_array().unwrap();
        assert!(!entries.is_empty());
        assert!(entries.iter().all(|entry| {
            entry["domain"] == domain
                && entry["enforcement"] == "ENFORCED"
                && entry["scope"]["kind"] == "TENANT"
        }));
        assert!(entries.iter().any(|entry| entry["level"] == level));
        let (status, body) = w
            .call(Method::GET, "/api/v1/access/roles", account, None)
            .await;
        assert_eq!(status, expected_status, "{body}");
    }
}
