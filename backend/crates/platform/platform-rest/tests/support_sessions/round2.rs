// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn non_approver_cannot_list_decide_or_end_and_leaves_ledger_unchanged(owner: PgPool) {
    let mut h = Support::new(owner).await;
    let id = Uuid::new_v4();
    ok(h.request(id).await, StatusCode::CREATED);
    ok(h.approve(id).await, StatusCode::OK);
    h.tenant = h.reader.clone();
    let before: Value =
        sqlx::query_scalar("SELECT to_jsonb(s) FROM support_sessions s WHERE id=$1")
            .bind(id)
            .fetch_one(&h.owner)
            .await
            .unwrap();
    code(
        h.send("GET", TENANT, Value::Null, &h.reader).await,
        StatusCode::FORBIDDEN,
        "forbidden",
    );
    for decision in ["APPROVE", "DENY"] {
        code(
            h.decide(id, decision).await,
            StatusCode::FORBIDDEN,
            "forbidden",
        );
    }
    code(
        h.send("POST", &format!("{TENANT}/{id}/end"), json!({}), &h.reader)
            .await,
        StatusCode::FORBIDDEN,
        "forbidden",
    );
    let after: Value = sqlx::query_scalar("SELECT to_jsonb(s) FROM support_sessions s WHERE id=$1")
        .bind(id)
        .fetch_one(&h.owner)
        .await
        .unwrap();
    assert_eq!(before, after);
    let decisions: i64 =
        sqlx::query_scalar("SELECT count(*) FROM support_session_decisions WHERE session_id=$1")
            .bind(id)
            .fetch_one(&h.owner)
            .await
            .unwrap();
    assert_eq!(decisions, 2);
    let active = h
        .send("GET", &format!("{TENANT}/active"), Value::Null, &h.reader)
        .await;
    assert_eq!(active.1["can_approve"], false);
    assert_eq!(active.1["pending_count"], 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn pending_approval_reaches_only_approvers_with_deadline_and_resolvable_operator(
    owner: PgPool,
) {
    let mut h = Support::new(owner).await;
    let id = Uuid::new_v4();
    ok(h.request(id).await, StatusCode::CREATED);
    let active = format!("{TENANT}/active");
    assert_eq!(
        h.send("GET", &active, Value::Null, &h.tenant).await.1["pending_count"],
        0
    );
    ok(h.approve(id).await, StatusCode::OK);
    let result = h.send("GET", &active, Value::Null, &h.tenant).await;
    assert_eq!(result.1["pending_count"], 1);
    assert_eq!(result.1["pending_approvals"][0]["id"], id.to_string());
    assert!(result.1["pending_approvals"][0]["request_expires_at"].is_string());
    let label = result.1["pending_approvals"][0]["operator_label"]
        .as_str()
        .unwrap();
    assert!(label.contains("Support operator"), "{label}");
    let vendor: String = sqlx::query_scalar("SELECT name FROM organizations WHERE id=$1")
        .bind(OrgId::platform().as_uuid())
        .fetch_one(&h.owner)
        .await
        .unwrap();
    assert!(label.contains(&vendor));
    assert!(!label.contains(&h.a.id.as_uuid().simple().to_string()));
    ok(h.decide(id, "DENY").await, StatusCode::OK);
    assert_eq!(
        h.send("GET", &active, Value::Null, &h.tenant).await.1["pending_count"],
        0
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn synced_actor_key_cannot_request_or_second_approve(owner: PgPool) {
    let mut h = Support::new(owner).await;
    let id = Uuid::new_v4();
    let mut body = h.body(id);
    body["step_up"] = h.proof_for(false, id, "request", &body).await;
    // Upgrade after verification so WebAuthn's backup-flag check cannot shadow the support hardware-key guard.
    sqlx::raw_sql("CREATE FUNCTION upgrade_support_key() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE auth_webauthn_credentials SET passkey_json=jsonb_set(passkey_json,'{cred,backup_eligible}','true') WHERE id=NEW.credential_row_id; RETURN NEW; END $$; CREATE TRIGGER upgrade_support_key AFTER INSERT ON step_up_assertions FOR EACH ROW EXECUTE FUNCTION upgrade_support_key()")
        .execute(&h.owner).await.unwrap();
    code(
        h.send("POST", PLATFORM, body, &h.a.token).await,
        StatusCode::UNAUTHORIZED,
        "support.refuse.step_up_required",
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM support_sessions")
            .fetch_one(&h.owner)
            .await
            .unwrap(),
        0
    );
    sqlx::query("ALTER TABLE step_up_assertions DISABLE TRIGGER upgrade_support_key")
        .execute(&h.owner)
        .await
        .unwrap();
    ok(h.request(id).await, StatusCode::CREATED);
    sqlx::query("ALTER TABLE step_up_assertions ENABLE TRIGGER upgrade_support_key")
        .execute(&h.owner)
        .await
        .unwrap();
    code(
        h.approve(id).await,
        StatusCode::UNAUTHORIZED,
        "support.refuse.step_up_required",
    );
    let state: String = sqlx::query_scalar("SELECT state FROM support_sessions WHERE id=$1")
        .bind(id)
        .fetch_one(&h.owner)
        .await
        .unwrap();
    assert_eq!(state, "REQUESTED");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn revocation_during_handler_withholds_content_and_records_refusal(owner: PgPool) {
    let mut h = Support::new(owner).await;
    let (id, token) = h.active().await;
    code(
        h.send("GET", &format!("{READ}?revoke=1"), Value::Null, &token)
            .await,
        StatusCode::UNAUTHORIZED,
        "support.refuse.session_ended",
    );
    let status: String = sqlx::query_scalar("SELECT after_snap->>'status' FROM audit_events WHERE target_id=$1 AND action='support.access'")
        .bind(id.to_string()).fetch_one(&h.owner).await.unwrap();
    assert_eq!(status, "401");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn support_principal_has_no_legacy_branch_authority(owner: PgPool) {
    let mut h = Support::new(owner).await;
    sqlx::query("UPDATE support_read_surfaces SET field_classes=field_classes || '{\"branch_scope_empty\":\"metadata\"}'::jsonb WHERE path=$1")
        .bind(READ).execute(&h.owner).await.unwrap();
    let (_, token) = h.active().await;
    let read = h.send("GET", READ, Value::Null, &token).await;
    assert_eq!(read.0, StatusCode::OK, "{}", read.1);
    assert_eq!(read.1["branch_scope_empty"], true);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn every_mutation_verb_is_refused_before_the_handler(owner: PgPool) {
    let mut h = Support::new(owner).await;
    let (_, token) = h.active().await;
    for method in ["POST", "PUT", "PATCH", "DELETE"] {
        code(
            h.send(method, READ, json!({}), &token).await,
            StatusCode::FORBIDDEN,
            "support.refuse.read_only",
        );
    }
    assert_eq!(h.writes.load(Ordering::SeqCst), 0);
}
