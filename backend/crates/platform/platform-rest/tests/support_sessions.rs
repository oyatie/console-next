// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[allow(dead_code)]
#[path = "fixtures/rename.rs"]
mod fixture;
#[path = "fixtures/support_sessions.rs"]
mod support;
use console_kernel_core::OrgId;
use console_platform_rest::expire_support_sessions;
use console_settings_domain::{SettingKey, SettingValue};
use fixture::Harness;
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::atomic::Ordering;
use support::{PLATFORM, READ, Support, TENANT, code, ok};
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn support_missing_step_up_has_problem_code(owner: PgPool) {
    let h = Harness::new(owner).await;
    let org = h.onboard("support-negative").await;
    let result = h.send("POST", "/api/platform/support-sessions", json!({
        "id":Uuid::new_v4(),"org_id":org,"ticket_ref":"TICKET-123",
        "reason_code":"TROUBLESHOOT","reason":"조회 오류 조사", "scope":["hr_basic"],"duration_seconds":60
    })).await;
    assert_eq!(result.0, StatusCode::UNAUTHORIZED, "{}", result.1);
    assert_eq!(result.1["code"], "support.refuse.step_up_required");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn tenant_approved_read_is_masked_logged_and_immediately_revocable(owner: PgPool) {
    let mut h = Support::new(owner).await;
    let (id, token) = h.active().await;
    assert_eq!(h.accesses(id).await, 0);
    let read = h.send("GET", READ, Value::Null, &token).await;
    assert_eq!(read.0, StatusCode::OK, "{}", read.1);
    for field in ["display_name", "phone", "personal_email"] {
        assert_eq!(read.1[field], "••••");
    }
    assert_eq!(h.accesses(id).await, 1);
    let active = h
        .send("GET", &format!("{TENANT}/active"), Value::Null, &h.tenant)
        .await;
    assert_eq!(active.1["sessions"][0]["id"], id.to_string());
    let history = h.send("GET", TENANT, Value::Null, &h.tenant).await;
    assert_eq!(history.1["sessions"][0]["records"][0]["path"], READ);
    assert_eq!(
        history.1["sessions"][0]["decisions"]
            .as_array()
            .unwrap()
            .len(),
        4
    );
    let audit:(Uuid,String,String)=sqlx::query_as("SELECT org_id,actor_display,after_snap->>'kind' FROM audit_events WHERE action='support.access' AND target_id=$1")
        .bind(id.to_string()).fetch_one(&h.owner).await.unwrap();
    assert_eq!(audit.0, h.org);
    assert!(!audit.1.contains(&h.a.id.to_string()));
    assert!(audit.1.contains(" · "));
    assert_eq!(audit.2, "공급사");
    ok(
        h.send("POST", &format!("{TENANT}/{id}/end"), json!({}), &h.tenant)
            .await,
        StatusCode::OK,
    );
    code(
        h.send("GET", READ, Value::Null, &token).await,
        StatusCode::UNAUTHORIZED,
        "support.refuse.session_ended",
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn distinct_operator_tenant_consent_and_request_deadline_are_required(owner: PgPool) {
    let mut h = Support::new(owner).await;
    let id = Uuid::new_v4();
    ok(h.request(id).await, StatusCode::CREATED);
    code(
        h.signed(false, id, "approve", json!({"org_id":h.org}))
            .await,
        StatusCode::FORBIDDEN,
        "support.refuse.requester_cannot_approve",
    );
    ok(h.approve(id).await, StatusCode::OK);
    code(
        h.start(id).await,
        StatusCode::CONFLICT,
        "support.refuse.not_tenant_approved",
    );
    sqlx::query(
        "UPDATE support_sessions SET request_expires_at=now()-interval '1 second' WHERE id=$1",
    )
    .bind(id)
    .execute(&h.owner)
    .await
    .unwrap();
    code(
        h.start(id).await,
        StatusCode::CONFLICT,
        "support.refuse.request_expired",
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_solo_operator_receives_an_honest_refusal(owner: PgPool) {
    let mut h = Support::new(owner).await;
    sqlx::query("UPDATE users SET is_active=false WHERE org_id=$1 AND id<>$2")
        .bind(OrgId::platform().as_uuid())
        .bind(h.a.id.as_uuid())
        .execute(&h.owner)
        .await
        .unwrap();
    code(
        h.request(Uuid::new_v4()).await,
        StatusCode::CONFLICT,
        "support.refuse.no_second_operator",
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM support_sessions")
        .fetch_one(&h.owner)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn request_without_a_tenant_approver_is_refused(owner: PgPool) {
    let mut h = Support::new(owner).await;
    h.org = Uuid::new_v4();
    console_platform_test_support::seed_org_rls_off(&h.owner, h.org, "support-without-account")
        .await;
    code(
        h.request(Uuid::new_v4()).await,
        StatusCode::CONFLICT,
        "support.refuse.no_tenant_approver",
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn support_cannot_write_escape_scope_or_reveal_without_a_grant(owner: PgPool) {
    let mut h = Support::new(owner).await;
    let (_, token) = h.active().await;
    code(
        h.send("POST", READ, json!({"display_name":"changed"}), &token)
            .await,
        StatusCode::FORBIDDEN,
        "support.refuse.read_only",
    );
    assert_eq!(h.writes.load(Ordering::SeqCst), 0);
    for path in ["/api/v1/org-units", "/api/v1/unreviewed-read"] {
        code(
            h.send("GET", path, Value::Null, &token).await,
            StatusCode::FORBIDDEN,
            "support.refuse.out_of_scope",
        );
    }
    code(
        h.send(
            "POST",
            &format!("{READ}/{}/rrn/reveal", Uuid::new_v4()),
            json!({}),
            &token,
        )
        .await,
        StatusCode::FORBIDDEN,
        "support.refuse.reveal_not_granted",
    );
    let wrong_tier = h.send("GET", READ, Value::Null, &h.a.token).await;
    assert_eq!(wrong_tier.0, StatusCode::UNAUTHORIZED);
    assert_eq!(wrong_tier.1["error"]["code"], "unauthorized");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn expired_support_session_returns_its_specific_unauthorized_code(owner: PgPool) {
    let mut h = Support::new(owner).await;
    let (id, token) = h.active().await;
    sqlx::query("UPDATE support_sessions SET started_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE id=$1")
        .bind(id).execute(&h.owner).await.unwrap();
    code(
        h.send("GET", READ, Value::Null, &token).await,
        StatusCode::UNAUTHORIZED,
        "support.refuse.session_expired",
    );
    assert_eq!(expire_support_sessions(&h.rt).await.unwrap(), 1);
    let state: String = sqlx::query_scalar("SELECT state FROM support_sessions WHERE id=$1")
        .bind(id)
        .fetch_one(&h.owner)
        .await
        .unwrap();
    assert_eq!(state, "EXPIRED");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn failed_access_record_withholds_the_read_response(owner: PgPool) {
    let mut h = Support::new(owner).await;
    let (id, token) = h.active().await;
    sqlx::raw_sql("CREATE FUNCTION reject_support_access() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected support audit failure'; END $$; CREATE TRIGGER reject_support_access BEFORE INSERT ON audit_events FOR EACH ROW WHEN (NEW.action='support.access') EXECUTE FUNCTION reject_support_access()")
        .execute(&h.owner).await.unwrap();
    let result = h.send("GET", READ, Value::Null, &token).await;
    assert_eq!(result.0, StatusCode::INTERNAL_SERVER_ERROR, "{}", result.1);
    assert_eq!(result.1["code"], "internal");
    assert!(result.1.get("display_name").is_none());
    assert_eq!(h.accesses(id).await, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn deadlines_and_duration_follow_registry_keys_and_worker_expires_unanswered_requests(
    owner: PgPool,
) {
    let mut h = Support::new(owner).await;
    let hours = |key: SettingKey| match key.def().default {
        Some(SettingValue::Int(value)) => value,
        _ => panic!("support policy must be a duration"),
    };
    let max = hours(SettingKey::SupportMaxDuration) * 3600;
    let expiry = hours(SettingKey::SupportRequestExpiry) * 3600;
    let id = Uuid::new_v4();
    let mut body = h.body(id);
    body["duration_seconds"] = json!(max * 2);
    ok(
        h.signed(false, id, "request", body).await,
        StatusCode::CREATED,
    );
    let row:(i64,f64)=sqlx::query_as("SELECT requested_duration_seconds,extract(epoch FROM request_expires_at-requested_at)::float8 FROM support_sessions WHERE id=$1")
        .bind(id).fetch_one(&h.owner).await.unwrap();
    assert_eq!(row.0, max);
    assert_eq!(row.1, expiry as f64);
    sqlx::query(
        "UPDATE support_sessions SET request_expires_at=now()-interval '1 second' WHERE id=$1",
    )
    .bind(id)
    .execute(&h.owner)
    .await
    .unwrap();
    assert_eq!(expire_support_sessions(&h.rt).await.unwrap(), 1);
    code(
        h.approve(id).await,
        StatusCode::CONFLICT,
        "support.refuse.request_expired",
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn bound_assertion_cannot_authorize_changed_request_payload(owner: PgPool) {
    let mut h = Support::new(owner).await;
    let id = Uuid::new_v4();
    let mut body = h.body(id);
    body["step_up"] = h.proof_for(false, id, "request", &body).await;
    body["reason"] = json!("署名後に変更");
    code(
        h.send("POST", PLATFORM, body, &h.a.token).await,
        StatusCode::UNAUTHORIZED,
        "support.refuse.step_up_required",
    );
}

#[path = "support_sessions/boundary.rs"]
mod boundary;

#[path = "support_sessions/round2.rs"]
mod round2;

#[path = "support_sessions/surfaces.rs"]
mod surfaces;

#[path = "support_sessions/policy.rs"]
mod policy;
