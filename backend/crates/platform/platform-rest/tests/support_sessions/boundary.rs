// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn tenant_denial_is_audited_in_target_org_and_vendor_reads_only_metadata(owner: PgPool) {
    let mut h = Support::new(owner).await;
    let id = Uuid::new_v4();
    ok(h.request(id).await, StatusCode::CREATED);
    ok(h.approve(id).await, StatusCode::OK);
    ok(h.decide(id, "DENY").await, StatusCode::OK);
    let audit:(Uuid,String)=sqlx::query_as("SELECT org_id,actor_display FROM audit_events WHERE action='support.deny' AND target_id=$1")
        .bind(id.to_string()).fetch_one(&h.owner).await.unwrap();
    assert_eq!(audit.0, h.org);
    assert!(!audit.1.is_empty());
    let list = h
        .send(
            "GET",
            &format!("{PLATFORM}?org_id={}", h.org),
            Value::Null,
            &h.a.token,
        )
        .await;
    assert_eq!(list.0, StatusCode::OK, "{}", list.1);
    for field in [
        "ticket_ref",
        "reason",
        "tenant_approver_ref",
        "reveal_classes",
    ] {
        assert!(list.1["sessions"][0].get(field).is_none(), "{field}");
    }
    code(
        h.start(id).await,
        StatusCode::UNAUTHORIZED,
        "support.refuse.session_ended",
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn websocket_subprotocol_cannot_bypass_support_scope_or_audit(owner: PgPool) {
    use tower::ServiceExt;
    let mut h = Support::new(owner).await;
    let (id, token) = h.active().await;
    let response = h
        .app
        .clone()
        .oneshot(
            http::Request::builder()
                .uri("/api/stream")
                .header("sec-websocket-protocol", format!("bearer, {token}"))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["code"], "support.refuse.out_of_scope");
    assert_eq!(h.accesses(id).await, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_deprivileged_key_holder_is_not_a_second_operator(owner: PgPool) {
    let mut h = Support::new(owner).await;
    sqlx::query("UPDATE users SET is_active=false WHERE org_id=$1 AND id<>$2 AND id<>$3")
        .bind(OrgId::platform().as_uuid())
        .bind(h.a.id.as_uuid())
        .bind(h.b.id.as_uuid())
        .execute(&h.owner)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET roles=ARRAY[]::text[] WHERE id=$1")
        .bind(h.b.id.as_uuid())
        .execute(&h.owner)
        .await
        .unwrap();
    code(
        h.request(Uuid::new_v4()).await,
        StatusCode::CONFLICT,
        "support.refuse.no_second_operator",
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn support_extractor_and_generic_failures_are_problem_details(owner: PgPool) {
    let mut h = Support::new(owner).await;
    let malformed = h
        .send("POST", PLATFORM, json!({"id":"invalid"}), &h.a.token)
        .await;
    assert_eq!(malformed.0, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(malformed.1["status"], 422);
    assert_eq!(malformed.1["code"], "validation");
    let id = Uuid::new_v4();
    ok(h.request(id).await, StatusCode::CREATED);
    ok(h.approve(id).await, StatusCode::OK);
    let repeated = h.approve(id).await;
    assert_eq!(repeated.0, StatusCode::CONFLICT);
    assert_eq!(repeated.1["status"], 409);
    assert_eq!(repeated.1["code"], "conflict");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn policy_duration_is_honored_and_the_operator_family_still_revokes_support(owner: PgPool) {
    let mut h = Support::new(owner).await;
    let seconds = match SettingKey::SupportMaxDuration.def().default {
        Some(SettingValue::Int(hours)) => hours * 3600,
        _ => panic!("support duration must be registered"),
    };
    let id = Uuid::new_v4();
    let mut body = h.body(id);
    body["duration_seconds"] = json!(seconds);
    ok(
        h.signed(false, id, "request", body).await,
        StatusCode::CREATED,
    );
    ok(h.approve(id).await, StatusCode::OK);
    ok(
        h.send(
            "POST",
            &format!("{TENANT}/{id}/decision"),
            json!({
                "decision":"APPROVE", "approved_duration_seconds":seconds,"reveal_classes":[]
            }),
            &h.tenant,
        )
        .await,
        StatusCode::OK,
    );
    let started = h.start(id).await;
    assert_eq!(started.0, StatusCode::OK, "{}", started.1);
    let duration: f64 = sqlx::query_scalar("SELECT extract(epoch FROM expires_at-started_at)::float8 FROM support_sessions WHERE id=$1")
        .bind(id).fetch_one(&h.owner).await.unwrap();
    assert_eq!(
        duration, seconds as f64,
        "the tenant-approved policy duration must not be replaced by the operator JWT refresh interval"
    );
    sqlx::query("UPDATE auth_refresh_token_families SET revoked_at=now(),revoked_reason='logout' WHERE user_id=$1")
        .bind(h.a.id.as_uuid()).execute(&h.owner).await.unwrap();
    code(
        h.send(
            "GET",
            READ,
            Value::Null,
            started.1["access_token"].as_str().unwrap(),
        )
        .await,
        StatusCode::UNAUTHORIZED,
        "support.refuse.session_ended",
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_support_read_validation_refusal_is_problem_details_and_is_recorded(owner: PgPool) {
    let mut h = Support::new(owner).await;
    let (id, token) = h.active().await;
    code(
        h.send("GET", &format!("{READ}?page=invalid"), Value::Null, &token)
            .await,
        StatusCode::BAD_REQUEST,
        "validation",
    );
    assert_eq!(h.accesses(id).await, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_personal_grant_reveals_only_classified_personal_fields_with_a_record(owner: PgPool) {
    let mut h = Support::new(owner).await;
    let id = Uuid::new_v4();
    ok(h.request(id).await, StatusCode::CREATED);
    ok(h.approve(id).await, StatusCode::OK);
    ok(
        h.send(
            "POST",
            &format!("{TENANT}/{id}/decision"),
            json!({
                "decision":"APPROVE","approved_duration_seconds":60,"reveal_classes":["personal"]
            }),
            &h.tenant,
        )
        .await,
        StatusCode::OK,
    );
    let started = h.start(id).await;
    assert_eq!(started.0, StatusCode::OK, "{}", started.1);
    let read = h
        .send(
            "GET",
            READ,
            Value::Null,
            started.1["access_token"].as_str().unwrap(),
        )
        .await;
    assert_eq!(read.0, StatusCode::OK, "{}", read.1);
    assert_eq!(read.1["display_name"], "고객 이름");
    assert_eq!(read.1["personal_email"], "private@example.com");
    assert_eq!(
        read.1["phone"], "••••",
        "an unclassified alias remains masked"
    );
    assert_eq!(h.accesses(id).await, 1);
}
