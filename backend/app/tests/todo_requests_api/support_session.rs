// SPDX-License-Identifier: LicenseRef-Proprietary
//! A vendor support session never asks anyone, nor lists whom it could.

use console_kernel_core::OrgId;
use console_platform_auth::{
    AccessTokenInput, ActorSession, JwtIssuer, JwtSettings, RefreshTokenStore,
};
use http::{Method, StatusCode};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::support::add_user;
use crate::transport::{self, Call};
use crate::{ASSIGNEES, REQUESTS, ask_body, code, office};

/// A support token for an active session over `org`, read-only as every session is.
async fn support_token(pool: &PgPool, org: Uuid, approver: Uuid) -> (String, String) {
    let operator = add_user(pool, *OrgId::platform().as_uuid(), &["SUPER_ADMIN"]).await;
    let session = Uuid::new_v4();
    let ttl = Duration::minutes(5);
    sqlx::query("INSERT INTO support_sessions(org_id,id,operator_ref,operator_label,ticket_ref,reason_code,reason,scope,requested_duration_seconds,approved_duration_seconds,state,request_expires_at,request_assertion,operator_approver_ref,operator_approved_at,approval_assertion,tenant_approver_ref,tenant_approved_at,started_at,expires_at) VALUES($1,$2,$3,'Support operator','SUPPORT-ASK','DIAGNOSE','Request reach check',ARRAY['org','hr_basic'],$4,$4,'ACTIVE',now()+$4*interval '1 second',gen_random_uuid(),gen_random_uuid(),now(),gen_random_uuid(),$5,now(),now(),now()+$4*interval '1 second')")
        .bind(org).bind(session).bind(operator.as_uuid()).bind(ttl.whole_seconds()).bind(approver)
        .execute(pool).await.unwrap();
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
            .fetch_one(pool)
            .await
            .unwrap();
    let family = RefreshTokenStore
        .issue_family(pool, *operator.as_uuid(), OrgId::platform(), now, ttl)
        .await
        .unwrap();
    console_platform_test_support::seed_session_consent(pool, family.family_id).await;
    let input = AccessTokenInput {
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
    };
    let actor = ActorSession {
        family_id: family.family_id,
        expires_at: family.expires_at.unix_timestamp(),
        home_org: OrgId::platform(),
        subject_version: 0,
        session_generation: 0,
    };
    let token = issuer
        .issue_support_access_token(input, actor, ttl)
        .unwrap();
    (token, public)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_support_session_is_refused_on_both_routes(pool: PgPool) {
    let o = office(pool).await;
    let (token, public) = support_token(&o.pool, o.org, *o.admin.user.as_uuid()).await;
    let app = console_app::build_router(transport::app_state(
        transport::runtime_pool(&o.pool).await,
        public,
    ));
    let ask = Call {
        method: Method::POST,
        uri: REQUESTS.to_owned(),
        token: &token,
        peer: transport::DIRECT_PEER,
        forwarded_for: "",
        body: Some((
            "application/json".to_owned(),
            ask_body(&o.colleague).to_string().into_bytes(),
        )),
    };
    let list = transport::get(ASSIGNEES.to_owned(), &token, transport::DIRECT_PEER, "");
    // The platform's support guard answers first; the handler's own support
    // check stands behind it (see the handler's unit test).
    for (call, want) in [
        (ask, "support.refuse.read_only"),
        (list, "support.refuse.out_of_scope"),
    ] {
        let uri = call.uri.clone();
        let (status, out) = transport::send(&app, call).await;
        assert_eq!(
            (status, code(&out)),
            (StatusCode::FORBIDDEN, want),
            "{uri}: {out}"
        );
    }
    assert_eq!(o.written().await, (0, 0));
}
