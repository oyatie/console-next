// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod settings_support;
use console_app::build_router;
use http::StatusCode;
use serde_json::json;
use settings_support::*;
use sqlx::PgPool;
use uuid::Uuid;

const PATH: &str = "/api/v1/settings/auth.idle_timeout_minutes";

async fn fixture(pool: &PgPool) -> (Uuid, axum::Router, String) {
    let org = Uuid::new_v4();
    let admin = console_platform_test_support::seed_org_and_super_admin(pool, org, "plan").await;
    console_platform_test_support::seed_passkey(
        pool,
        console_kernel_core::OrgId::from_uuid(org),
        admin,
    )
    .await;
    let keys = keys();
    let manager = seed_user(pool, org, "MEMBER").await;
    seed_role_and_grant(pool, org, admin, manager, "TENANT", None).await;
    let token = token(pool, &keys, org, manager, "MEMBER").await;
    let service = build_router(app_state(runtime_pool(pool).await, keys.1).unwrap());
    (org, service, token)
}

async fn counts(pool: &PgPool, org: Uuid) -> (i64, i64, i64) {
    sqlx::query_as("SELECT (SELECT count(*) FROM tenant_setting_overrides WHERE org_id=$1), (SELECT count(*) FROM audit_events WHERE org_id=$1), (SELECT count(*) FROM command_outcomes WHERE org_id=$1)")
        .bind(org).fetch_one(pool).await.unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn dry_run_inserts_nothing_and_audits_nothing(pool: PgPool) {
    let metrics = console_app::install_metrics_recorder().unwrap();
    let (org, service, token) = fixture(&pool).await;
    let before = counts(&pool, org).await;
    let change = json!({"value": 20, "reason_code": "POLICY_REVIEW"});
    for query in ["true", "%74rue"] {
        let (status, body) = send(
            &service,
            "POST",
            &format!("{PATH}?dry_run={query}"),
            Some(&token),
            Some(change.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["path"], "direct");
        assert_eq!(counts(&pool, org).await, before);
    }
    let rendered = metrics.render();
    assert!(
        rendered.contains("settings_change_plans_total{path=\"direct\",direction=\"tighten\"}"),
        "{rendered}"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn dry_run_403_preserves_cedar_scope_checks_and_audits_refusals(pool: PgPool) {
    let (org, _, _) = fixture(&pool).await;
    let keys = keys();
    let service = build_router(app_state(runtime_pool(&pool).await, keys.1.clone()).unwrap());
    let granter = seed_user(&pool, org, "SUPER_ADMIN").await;
    let a = seed_legal_entity(&pool, org, granter).await;
    let b = seed_legal_entity(&pool, org, granter).await;
    let scoped = seed_user(&pool, org, "MEMBER").await;
    seed_role_and_grant(&pool, org, granter, scoped, "LEGAL_ENTITY", Some(a)).await;
    let token = token(&pool, &keys, org, scoped, "MEMBER").await;
    let ungranted = seed_user(&pool, org, "MEMBER").await;
    let ungranted_token = settings_support::token(&pool, &keys, org, ungranted, "MEMBER").await;
    for (scope, bearer, code) in [
        (None, &token, "scope_tenant_wide_only"),
        (Some(b), &token, "out_of_scope"),
        (Some(a), &ungranted_token, "forbidden"),
    ] {
        let change = json!({"value": 20, "reason_code": "POLICY_REVIEW", "scope_entity_id": scope});
        let before = counts(&pool, org).await;
        let (status, preview) = send(
            &service,
            "POST",
            &format!("{PATH}?dry_run=true"),
            Some(bearer),
            Some(change.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{preview}");
        assert_eq!(preview["error"]["code"], code);
        assert_eq!(counts(&pool, org).await, (before.0, before.1 + 1, before.2));
        let denied: (String, String, Option<Uuid>) = sqlx::query_as(
            "SELECT outcome, after_snap->>'refusal_code', command_id FROM audit_events WHERE org_id=$1 AND action='command.refused' ORDER BY created_at DESC, id DESC LIMIT 1",
        ).bind(org).fetch_one(&pool).await.unwrap();
        assert_eq!(denied, ("DENIED".into(), code.into(), None));
        let (status, written) = send(&service, "POST", PATH, Some(bearer), Some(change)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{written}");
        assert_eq!(written["error"]["code"], preview["error"]["code"]);
        assert_eq!(written["error"]["message"], preview["error"]["message"]);
        let denied_count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='command.refused' AND outcome='DENIED' AND after_snap->>'refusal_code'=$2",
        ).bind(org).bind(code).fetch_one(&pool).await.unwrap();
        assert_eq!(denied_count, 2);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn dry_run_domain_refusals_match_write_and_expose_earliest(pool: PgPool) {
    let (org, service, token) = fixture(&pool).await;
    sqlx::query("INSERT INTO employees (id,org_id,company,name,source_filename,source_sheet,source_row,source_key,raw_row,source_metadata) VALUES ($1,$2,'test','S','test','employees',1,$3,'{}','{}')")
        .bind(Uuid::new_v4()).bind(org).bind(Uuid::new_v4().to_string()).execute(&pool).await.unwrap();
    let past = (time::OffsetDateTime::now_utc() - time::Duration::days(1))
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap();
    for (key, change, status, code) in [
        (
            PATH.to_owned(),
            json!({"value": 0, "reason_code": "POLICY_REVIEW"}),
            StatusCode::UNPROCESSABLE_ENTITY,
            "setting_out_of_range",
        ),
        (
            PATH.to_owned(),
            json!({"value": "bad", "reason_code": "POLICY_REVIEW"}),
            StatusCode::UNPROCESSABLE_ENTITY,
            "setting_value_invalid",
        ),
        (
            PATH.to_owned(),
            json!({"value": 20, "reason_code": "POLICY_REVIEW", "effective_from": past}),
            StatusCode::UNPROCESSABLE_ENTITY,
            "setting_backdated",
        ),
        (
            PATH.to_owned(),
            json!({"value": 60, "reason_code": "POLICY_REVIEW"}),
            StatusCode::CONFLICT,
            "setting_loosening_too_soon",
        ),
        (
            "/api/v1/settings/no.such.key".to_owned(),
            json!({"value": 20, "reason_code": "POLICY_REVIEW"}),
            StatusCode::UNPROCESSABLE_ENTITY,
            "setting_unknown_key",
        ),
    ] {
        for query in ["?dry_run=true", ""] {
            let before = counts(&pool, org).await;
            let (got, body) = send(
                &service,
                "POST",
                &format!("{key}{query}"),
                Some(&token),
                Some(change.clone()),
            )
            .await;
            assert_eq!(got, status, "{body}");
            assert_eq!(body["error"]["code"], code);
            if !query.is_empty() {
                assert_eq!(counts(&pool, org).await, before);
            }
            if code == "setting_loosening_too_soon" {
                assert!(body["error"]["earliest_effective_from"].as_str().is_some());
            }
        }
    }
}
