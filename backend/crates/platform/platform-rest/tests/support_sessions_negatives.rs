// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[allow(dead_code)]
#[path = "fixtures/rename.rs"]
mod fixture;
#[allow(dead_code)]
#[path = "fixtures/support_sessions.rs"]
mod support;

use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use support::{PLATFORM, Support, TENANT, code, ok};
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn support_sessions_enforce_isolation_lengths_conflicts_revocation_and_sync_guard(
    owner: PgPool,
) {
    let mut h = Support::new(owner.clone()).await;
    let other = Support::new(owner.clone()).await;

    let id = Uuid::new_v4();
    ok(h.request(id).await, StatusCode::CREATED);

    // Safe additive metadata fields are returned while sensitive fields stay excluded.
    let list = h
        .send(
            "GET",
            &format!("{PLATFORM}?org_id={}", h.org),
            Value::Null,
            &h.a.token,
        )
        .await;
    assert_eq!(list.0, StatusCode::OK, "{}", list.1);
    let item = &list.1["sessions"][0];
    for safe in [
        "request_expires_at",
        "requested_duration_seconds",
        "scope",
        "operator_approver_ref",
        "tenant_approved",
    ] {
        assert!(
            item.get(safe).is_some(),
            "missing safe field {safe}: {item}"
        );
    }
    assert_eq!(item["tenant_approved"], false);
    for hidden in [
        "ticket_ref",
        "reason",
        "tenant_approver_ref",
        "reveal_classes",
        "approved_duration_seconds",
    ] {
        assert!(
            item.get(hidden).is_none(),
            "sensitive field leaked {hidden}: {item}"
        );
    }

    // Duplicate (org_id, id) -> 409 conflict (never 500).
    let dup = h.signed(false, id, "request", h.body(id)).await;
    assert_eq!(dup.0, StatusCode::CONFLICT, "{}", dup.1);

    // Overlong ticket_ref (>200), reason_code (>100), reason (>2000) -> 422.
    for (field, len) in [("ticket_ref", 201), ("reason_code", 101), ("reason", 2001)] {
        let bad_id = Uuid::new_v4();
        let mut body = h.body(bad_id);
        body[field] = json!("x".repeat(len));
        let resp = h.send("POST", PLATFORM, body, &h.a.token).await;
        assert_eq!(
            resp.0,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{field}: {}",
            resp.1
        );
    }

    // Cross-tenant isolation: another org cannot see, decide, or end h's session -> 404.
    let other_list = other.send("GET", TENANT, Value::Null, &other.tenant).await;
    assert_eq!(other_list.0, StatusCode::OK);
    assert_eq!(other_list.1["sessions"].as_array().unwrap().len(), 0);
    assert_eq!(other.decide(id, "APPROVE").await.0, StatusCode::NOT_FOUND);
    assert_eq!(
        other
            .send(
                "POST",
                &format!("{TENANT}/{id}/end"),
                json!({}),
                &other.tenant
            )
            .await
            .0,
        StatusCode::NOT_FOUND
    );

    // Mismatched org_id on platform approve/start/end (with matching step-up proof) -> 404.
    let wrong_org = json!({ "org_id": other.org });
    let mut wrong_approve = wrong_org.clone();
    wrong_approve["step_up"] = {
        use sha2::{Digest, Sha256};
        let hash: String =
            Sha256::digest(serde_json::to_vec(&json!([other.org, id, "approve"])).unwrap())
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
        let binding = console_platform_auth::MobilePasskeyStepUpBinding::bound(
            console_platform_auth::MobileStepUpActionKind::SupportSession,
            id,
            hash,
        );
        let cer = console_platform_test_support::soft_passkey::passkey_service()
            .start_mobile_step_up(&owner, *h.b.id.as_uuid(), binding.clone())
            .await
            .unwrap();
        let mut ch = serde_json::to_value(cer.challenge).unwrap();
        ch["publicKey"]["allowCredentials"] =
            json!([{"type":"public-key","id":h.b.key.credential_id()}]);
        json!({"binding":binding,"assertion":{"ceremony_id":cer.ceremony_id,"credential":h.b.key.assert(&ch).unwrap()}})
    };
    let mut wrong_start = wrong_org.clone();
    wrong_start["step_up"] = {
        use sha2::{Digest, Sha256};
        let hash: String =
            Sha256::digest(serde_json::to_vec(&json!([other.org, id, "start"])).unwrap())
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
        let binding = console_platform_auth::MobilePasskeyStepUpBinding::bound(
            console_platform_auth::MobileStepUpActionKind::SupportSession,
            id,
            hash,
        );
        let cer = console_platform_test_support::soft_passkey::passkey_service()
            .start_mobile_step_up(&owner, *h.a.id.as_uuid(), binding.clone())
            .await
            .unwrap();
        let mut ch = serde_json::to_value(cer.challenge).unwrap();
        ch["publicKey"]["allowCredentials"] =
            json!([{"type":"public-key","id":h.a.key.credential_id()}]);
        json!({"binding":binding,"assertion":{"ceremony_id":cer.ceremony_id,"credential":h.a.key.assert(&ch).unwrap()}})
    };
    assert_eq!(
        h.send(
            "POST",
            &format!("{PLATFORM}/{id}/approve"),
            wrong_approve,
            &h.b.token
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        h.send(
            "POST",
            &format!("{PLATFORM}/{id}/start"),
            wrong_start,
            &h.a.token
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        h.send(
            "POST",
            &format!("{PLATFORM}/{id}/end"),
            wrong_org,
            &h.a.token
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );

    // Synced passkey (backup_eligible=true) is rejected when other_eligible_holders > 0.
    let sync_id = Uuid::new_v4();
    let mut sync_body = h.body(sync_id);
    sync_body["step_up"] = h.proof_for(false, sync_id, "request", &sync_body).await;
    sqlx::raw_sql("CREATE FUNCTION mark_key_synced() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE auth_webauthn_credentials SET passkey_json=jsonb_set(passkey_json,'{cred,backup_eligible}','true') WHERE id=NEW.credential_row_id; RETURN NEW; END $$; CREATE TRIGGER mark_key_synced AFTER INSERT ON step_up_assertions FOR EACH ROW EXECUTE FUNCTION mark_key_synced()")
        .execute(&owner)
        .await
        .unwrap();
    code(
        h.send("POST", PLATFORM, sync_body, &h.a.token).await,
        StatusCode::UNAUTHORIZED,
        "support.refuse.step_up_required",
    );

    // Revoked operator token -> 401.
    sqlx::query("UPDATE users SET is_active = false WHERE id = $1")
        .bind(h.a.id.as_uuid())
        .execute(&owner)
        .await
        .unwrap();
    let revoked = h
        .send(
            "GET",
            &format!("{PLATFORM}?org_id={}", h.org),
            Value::Null,
            &h.a.token,
        )
        .await;
    assert_eq!(revoked.0, StatusCode::UNAUTHORIZED, "{}", revoked.1);
}
