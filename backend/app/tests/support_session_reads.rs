// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Support row reach through the real routers, with no tenant account grants.
#[path = "support/http.rs"]
mod support;
#[path = "access_log_reads/support.rs"]
mod transport;

use console_kernel_core::OrgId;
use console_platform_auth::{
    AccessTokenInput, ActorSession, JwtIssuer, JwtSettings, RefreshTokenStore,
};
use http::StatusCode;
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn support_reads_reach_rows_only_in_the_cedar_approved_domain(pool: PgPool) {
    let (org, owner) = support::tenant(&pool, &["SUPER_ADMIN"]).await;
    let admin = support::ctx(&pool, org, owner, &["SUPER_ADMIN"], None).await;
    let (entity, workplace, branch, unit) = support::structure(&admin).await;
    let (status, employee) = admin
        .call(
            "POST",
            "/api/v1/employees",
            Some(support::employee_body("SUPPORT-1", &branch, &unit)),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{employee}");
    let operator = support::add_user(&pool, *OrgId::platform().as_uuid(), &["SUPER_ADMIN"]).await;
    let session = Uuid::new_v4();
    let ttl = Duration::minutes(5);
    sqlx::query("INSERT INTO support_sessions(org_id,id,operator_ref,operator_label,ticket_ref,reason_code,reason,scope,requested_duration_seconds,approved_duration_seconds,state,request_expires_at,request_assertion,operator_approver_ref,operator_approved_at,approval_assertion,tenant_approver_ref,tenant_approved_at,started_at,expires_at) VALUES($1,$2,$3,'Support operator','SUPPORT-READS','DIAGNOSE','Row reach regression',ARRAY['org','hr_basic'],$4,$4,'ACTIVE',now()+$4*interval '1 second',gen_random_uuid(),gen_random_uuid(),now(),gen_random_uuid(),$5,now(),now(),now()+$4*interval '1 second')")
        .bind(org).bind(session).bind(operator.as_uuid()).bind(ttl.whole_seconds()).bind(owner.as_uuid()).execute(&pool).await.unwrap();
    let (private, public) = transport::signing_pems();
    let issuer = JwtIssuer::from_es256_pem(
        JwtSettings {
            issuer: transport::ISSUER.into(),
            audience: transport::AUDIENCE.into(),
            access_token_ttl: ttl,
        },
        private.as_bytes(),
        public.as_bytes(),
    )
    .unwrap();
    let now: OffsetDateTime =
        sqlx::query_scalar("SELECT started_at FROM support_sessions WHERE id=$1")
            .bind(session)
            .fetch_one(&pool)
            .await
            .unwrap();
    let family = RefreshTokenStore
        .issue_family(&pool, *operator.as_uuid(), OrgId::platform(), now, ttl)
        .await
        .unwrap();
    console_platform_test_support::seed_session_consent(&pool, family.family_id).await;
    let token = issuer
        .issue_support_access_token(
            AccessTokenInput {
                subject: operator,
                org_id: OrgId::from_uuid(org),
                roles: vec![],
                branches: vec![],
                platform: false,
                support: Some(session),
                read_only: true,
                display_name: None,
                feature_grants: vec![],
                authz_subject_version: 0,
                authz_policy_version: 0,
                session_generation: 0,
                issued_at: now,
            },
            ActorSession {
                family_id: family.family_id,
                expires_at: family.expires_at.unix_timestamp(),
                home_org: OrgId::platform(),
                subject_version: 0,
                session_generation: 0,
            },
            ttl,
        )
        .unwrap();
    let app = console_app::build_router(transport::app_state(
        transport::runtime_pool(&pool).await,
        public,
    ));
    for (path, field, identity, id) in [
        ("/api/v1/org-structure", "entities", "id", entity.as_str()),
        ("/api/v1/legal-entities", "items", "id", entity.as_str()),
        ("/api/v1/workplaces", "items", "id", workplace.as_str()),
        ("/api/v1/org-units", "items", "id", unit.as_str()),
        ("/api/v1/employees", "items", "org_unit_id", unit.as_str()),
    ] {
        let call = || transport::get(path.into(), &token, transport::DIRECT_PEER, "");
        let (status, body) = transport::send(&app, call()).await;
        assert_eq!(status, StatusCode::OK, "{path}: {body}");
        assert!(
            body[field]
                .as_array()
                .unwrap()
                .iter()
                .any(|row| row[identity] == id),
            "{path}: {body}"
        );
        if path == "/api/v1/employees" {
            assert_eq!(body["total"], 1);
            assert_eq!(body["items"].as_array().unwrap().len(), 1);
            assert_eq!(body["items"][0]["name"], "••••");
        }
        // The loader must refresh the session scope on the very next request.
        sqlx::query("UPDATE support_sessions SET scope=ARRAY[$2] WHERE id=$1")
            .bind(session)
            .bind(if path == "/api/v1/employees" {
                "org"
            } else {
                "hr_basic"
            })
            .execute(&pool)
            .await
            .unwrap();
        let (status, body) = transport::send(&app, call()).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{path}: {body}");
        assert_eq!(
            body["error"]["code"], "support.refuse.out_of_scope",
            "{body}"
        );
        sqlx::query("UPDATE support_sessions SET scope=ARRAY['org','hr_basic'] WHERE id=$1")
            .bind(session)
            .execute(&pool)
            .await
            .unwrap();
    }
}
