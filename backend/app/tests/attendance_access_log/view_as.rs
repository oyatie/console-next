// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_kernel_core::OrgId;
use console_platform_auth::{
    AccessTokenInput, ActorSession, JwtIssuer, JwtSettings, RefreshTokenStore,
};
use time::Duration;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn http_view_as_read_keeps_operator_actor_home_session_and_tenant_subject_set(pool: PgPool) {
    let (admin, people) = world(&pool).await;
    let operator = support::add_user(&pool, *OrgId::platform().as_uuid(), &["SUPER_ADMIN"]).await;
    let now = OffsetDateTime::now_utc();
    let ttl = Duration::minutes(5);
    let family = RefreshTokenStore
        .issue_family(
            &pool,
            *operator.as_uuid(),
            OrgId::platform(),
            now,
            Duration::hours(1),
        )
        .await
        .unwrap();
    console_platform_test_support::seed_session_consent(&pool, family.family_id).await;
    let session = Uuid::new_v4();
    sqlx::query("INSERT INTO support_sessions(org_id,id,operator_ref,operator_label,ticket_ref,reason_code,reason,scope,requested_duration_seconds,approved_duration_seconds,state,request_expires_at,request_assertion,operator_approver_ref,operator_approved_at,approval_assertion,tenant_approver_ref,tenant_approved_at,started_at,expires_at) VALUES($1,$2,$3,'지원 담당자','ACCESS-TEST','DIAGNOSE','접속기록 확인',ARRAY['hr_basic'],300,300,'ACTIVE',now()+interval '5 minutes',gen_random_uuid(),gen_random_uuid(),now(),gen_random_uuid(),$4,now(),now(),now()+interval '5 minutes')")
        .bind(admin.org).bind(session).bind(operator.as_uuid()).bind(admin.user.as_uuid()).execute(&pool).await.unwrap();
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
    let token = issuer
        .issue_support_access_token(
            AccessTokenInput {
                subject: operator,
                org_id: OrgId::from_uuid(admin.org),
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
    let before: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='employee.list_read'",
    )
    .bind(admin.org)
    .fetch_one(&pool)
    .await
    .unwrap();
    let start = OffsetDateTime::now_utc();
    let (status, body) = transport::send(
        &app,
        transport::get(
            "/api/v1/employees?limit=10".into(),
            &token,
            transport::DIRECT_PEER,
            "198.51.100.99",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let rows = sqlx::query("SELECT actor,occurred_at,ip,after_snap FROM audit_events WHERE org_id=$1 AND action='employee.list_read' ORDER BY occurred_at")
        .bind(admin.org).fetch_all(&pool).await.unwrap();
    assert_eq!(rows.len() as i64, before + 1);
    let row = rows.last().unwrap();
    assert_eq!(row.get::<Uuid, _>("actor"), *operator.as_uuid());
    assert!(row.get::<OffsetDateTime, _>("occurred_at") >= start);
    assert_eq!(row.get::<String, _>("ip"), "203.0.113.7");
    let after: Value = row.get("after_snap");
    assert_eq!(after["principal_type"], "SUPPORT_OPERATOR");
    assert_eq!(after["session_id"], family.family_id.to_string());
    assert_eq!(after["self_read"], false);
    let mut actual: Vec<String> = serde_json::from_value(after["subject_ids"].clone()).unwrap();
    let mut expected = people;
    actual.sort();
    expected.sort();
    assert_eq!(actual, expected);
    assert_eq!(after["subject_count"], 2);
    assert_eq!(body["items"].as_array().unwrap().len(), 2);
}
