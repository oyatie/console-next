// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Live Postgres HTTP verification for ops self-recovery contacts (AWS-ESDK-v2),
//! single-use recovery codes, replay resistance, and active recovery auto-cancel.

#[path = "fixtures/ops_self_recovery_rig.rs"]
mod rig;

use axum::http::{Method, StatusCode};
use console_kernel_core::OrgId;
use console_platform_auth_rest::OTP_REDEEM_PATH;
use console_platform_test_support::soft_passkey::SoftKey;
use rig::Rig;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn recovery_codes_redeem_strictly_once_encrypt_contacts_and_cancel_open_recovery(
    owner: PgPool,
) {
    let rig = Rig::new(owner).await;

    let (st, enroll_tok) = rig
        .call(
            Method::POST,
            OTP_REDEEM_PATH,
            None,
            Some(json!({ "otp": rig.ops_otp })),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{enroll_tok}");
    let enroll_jwt = enroll_tok["access_token"].as_str().unwrap();

    let (st, refused) = rig
        .call(
            Method::PUT,
            "/api/v1/auth/recovery/contact",
            Some(enroll_jwt),
            Some(json!({ "channel": "EMAIL", "value": "ops-sec@example.com", "consent_accepted": false })),
        )
        .await;
    assert_eq!(
        (st, refused["error"]["code"].clone()),
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            json!("recovery_contact_consent_required")
        )
    );

    let (phone_status, _) = rig
        .call(
            Method::PUT,
            "/api/v1/auth/recovery/contact",
            Some(enroll_jwt),
            Some(json!({ "channel":"PHONE","value":"01000000000","consent_accepted":true })),
        )
        .await;
    assert_eq!(phone_status, StatusCode::UNPROCESSABLE_ENTITY);

    let (st, contact) = rig
        .call(
            Method::PUT,
            "/api/v1/auth/recovery/contact",
            Some(enroll_jwt),
            Some(json!({ "channel": "EMAIL", "value": "ops-sec@example.com", "consent_accepted": true })),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{contact}");
    assert_eq!(contact["review_pending"], true);

    let (alg_id, key_ver): (String, i32) = sqlx::query_as(
        "SELECT alg_id, key_version FROM recovery_contacts WHERE org_id = $1 AND user_id = $2",
    )
    .bind(rig.org.as_uuid())
    .bind(rig.ops.as_uuid())
    .fetch_one(&rig.owner)
    .await
    .unwrap();
    assert_eq!(
        (alg_id.as_str(), key_ver),
        ("aws-esdk-v2-aes256-gcm-hkdf-sha256-kwp", 3)
    );

    let (st, generated) = rig
        .call(
            Method::POST,
            "/api/v1/auth/recovery/codes/generate",
            Some(enroll_jwt),
            Some(json!({})),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{generated}");
    let codes: Vec<String> = generated["codes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    assert_eq!(codes.len(), 10);
    let leaked: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id = $1 AND coalesce(after_snap::text, '') LIKE '%' || $2 || '%'",
    )
    .bind(rig.org.as_uuid())
    .bind(&codes[0])
    .fetch_one(&rig.owner)
    .await
    .unwrap();
    assert_eq!(
        leaked, 0,
        "cleartext recovery code must never appear in audit_events"
    );

    let mut old_key = SoftKey::enroll(&rig.owner, rig.org, rig.ops).await;
    let (st, login_res) = rig.login_passkey(&mut old_key).await;
    assert_eq!(st, StatusCode::OK, "{login_res}");
    let full_jwt = login_res["access_token"].as_str().unwrap();

    let (st, need_step_up) = rig
        .call(
            Method::POST,
            "/api/v1/auth/recovery/codes/generate",
            Some(full_jwt),
            Some(json!({})),
        )
        .await;
    assert_eq!(
        (st, need_step_up["error"]["code"].clone()),
        (
            StatusCode::PRECONDITION_REQUIRED,
            json!("passkey_step_up_required")
        )
    );
    let step_up = old_key.step_up(&rig.owner).await;
    let (st, regen) = rig
        .call(
            Method::POST,
            "/api/v1/auth/recovery/codes/generate",
            Some(full_jwt),
            Some(json!({ "step_up": step_up })),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{regen}");
    let fresh_code = regen["codes"][0].as_str().unwrap().to_owned();

    let req_id = Uuid::new_v4();
    let vendor = console_platform_test_support::seed_active_user(
        &rig.owner,
        *OrgId::platform().as_uuid(),
        "SUPER_ADMIN",
        "vendor-op",
    )
    .await;
    let _vendor_key = SoftKey::enroll(&rig.owner, OrgId::platform(), vendor).await;
    let vendor_cred: Uuid =
        sqlx::query_scalar("SELECT id FROM auth_webauthn_credentials WHERE user_id = $1 LIMIT 1")
            .bind(vendor.as_uuid())
            .fetch_one(&rig.owner)
            .await
            .unwrap();
    let open_assertion = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO step_up_assertions (ceremony_id, org_id, user_id, credential_row_id, action_kind, object_id, payload_hash, user_verified)
         VALUES ($1, $2, $3, $4, 'OPERATOR_RECOVERY', $5, repeat('a', 64), true)",
    )
    .bind(open_assertion)
    .bind(OrgId::platform().as_uuid())
    .bind(vendor.as_uuid())
    .bind(vendor_cred)
    .bind(req_id)
    .execute(&rig.owner)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO ops_recovery_requests (org_id, id, target_user_id, requested_by, opened_at, authoriser_role, authoriser_name, proofing_method, evidence_ref, open_assertion)
         VALUES ($1, $2, $3, $4, now(), 'REPRESENTATIVE', 'Rep', 'TEST', 'ev-1', $5)",
    )
    .bind(rig.org.as_uuid())
    .bind(req_id)
    .bind(rig.ops.as_uuid())
    .bind(vendor.as_uuid())
    .bind(open_assertion)
    .execute(&rig.owner)
    .await
    .unwrap();

    let (st_fake, fake_chal) = rig
        .call(
            Method::POST,
            "/api/v1/auth/recovery/challenge",
            None,
            Some(json!({ "identifier": format!("nobody@{}", rig.slug) })),
        )
        .await;
    let (st_real, real_chal) = rig
        .call(
            Method::POST,
            "/api/v1/auth/recovery/challenge",
            None,
            Some(json!({ "identifier": rig.ops_identifier })),
        )
        .await;
    assert_eq!(
        (st_fake, fake_chal["sent"].clone()),
        (StatusCode::OK, json!(true))
    );
    assert_eq!(
        (st_real, real_chal["sent"].clone()),
        (StatusCode::OK, json!(true))
    );
    let contact_code = rig.mailer.0.lock().unwrap().last().unwrap().1.clone();

    let step = old_key.step_up(&rig.owner).await;
    let (changed, _) = rig.call(Method::PUT, "/api/v1/auth/recovery/contact", Some(full_jwt),
        Some(json!({ "channel":"EMAIL","value":"new-contact@example.com","consent_accepted":true,"step_up": step }))).await;
    assert_eq!(changed, StatusCode::OK);
    let (outdated, _) = rig
        .call(
            Method::POST,
            "/api/v1/auth/recovery/redeem",
            None,
            Some(json!({ "recovery_code": fresh_code, "contact_code": contact_code })),
        )
        .await;
    assert_eq!(outdated, StatusCode::UNAUTHORIZED);
    let (new_issue, _) = rig
        .call(
            Method::POST,
            "/api/v1/auth/recovery/challenge",
            None,
            Some(json!({"identifier": rig.ops_identifier})),
        )
        .await;
    assert_eq!(new_issue, StatusCode::OK);
    let (recipient, contact_code) = rig.mailer.0.lock().unwrap().last().unwrap().clone();
    assert_eq!(recipient, "new-contact@example.com");

    let (st_old, _) = rig
        .call(
            Method::POST,
            "/api/v1/auth/recovery/redeem",
            None,
            Some(json!({ "recovery_code": codes[0], "contact_code": contact_code })),
        )
        .await;
    assert_eq!(st_old, StatusCode::UNAUTHORIZED);

    let payload = json!({ "recovery_code": fresh_code, "contact_code": contact_code });
    let (r1, r2) = tokio::join!(
        rig.call(
            Method::POST,
            "/api/v1/auth/recovery/redeem",
            None,
            Some(payload.clone())
        ),
        rig.call(
            Method::POST,
            "/api/v1/auth/recovery/redeem",
            None,
            Some(payload.clone())
        ),
    );
    let results = [r1, r2];
    let ok: Vec<&Value> = results
        .iter()
        .filter_map(|(s, b)| (*s == StatusCode::OK).then_some(b))
        .collect();
    let unauthorized = results
        .iter()
        .filter(|(s, _)| *s == StatusCode::UNAUTHORIZED)
        .count();
    assert_eq!((ok.len(), unauthorized), (1, 1), "{results:?}");
    assert_eq!(ok[0]["requires_passkey_setup"], true);
    assert_eq!(ok[0]["cancelled_recovery_request"], true);

    let (st_lost, _) = rig.login_passkey(&mut old_key).await;
    assert_eq!(
        st_lost,
        StatusCode::UNAUTHORIZED,
        "lost passkey must be revoked"
    );
    let cancelled: bool = sqlx::query_scalar(
        "SELECT cancelled_at IS NOT NULL FROM ops_recovery_requests WHERE org_id = $1 AND id = $2",
    )
    .bind(rig.org.as_uuid())
    .bind(req_id)
    .fetch_one(&rig.owner)
    .await
    .unwrap();
    assert!(
        cancelled,
        "open ops recovery request must auto-cancel on active tenant"
    );

    let _ = rig
        .call(
            Method::POST,
            "/api/v1/auth/recovery/challenge",
            None,
            Some(json!({ "identifier": rig.ops_identifier })),
        )
        .await;
    let next_contact_code = rig.mailer.0.lock().unwrap().last().unwrap().1.clone();
    let (st_replay, _) = rig
        .call(
            Method::POST,
            "/api/v1/auth/recovery/redeem",
            None,
            Some(json!({ "recovery_code": fresh_code, "contact_code": next_contact_code })),
        )
        .await;
    assert_eq!(
        st_replay,
        StatusCode::UNAUTHORIZED,
        "consumed recovery code must never redeem twice"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn first_contact_writers_leave_a_decryptable_contact(owner: PgPool) {
    use console_platform_db::with_org_conn;
    use console_platform_provisioning::{
        ProvisioningError,
        ops_self_recovery::{
            ExposeSecret, RecoveryChannel, decrypt_recovery_contact_tx, upsert_recovery_contact,
        },
    };
    let rig = Rig::new(owner).await;
    let uid = *rig.ops.as_uuid();
    let org = rig.org;
    let now = time::OffsetDateTime::now_utc();
    let save = |value| {
        upsert_recovery_contact(
            &rig.rt,
            &rig.cipher,
            org,
            uid,
            RecoveryChannel::Email,
            value,
            now,
        )
    };
    let (first, second) = tokio::join!(save("first@example.com"), save("second@example.com"));
    first.unwrap();
    second.unwrap();
    let cipher = rig.cipher;
    let saved = with_org_conn::<_, _, ProvisioningError>(&rig.rt, org, move |tx| {
        Box::pin(async move { decrypt_recovery_contact_tx(tx, &cipher, org, uid).await })
    })
    .await
    .unwrap()
    .unwrap();
    assert!(["first@example.com", "second@example.com"].contains(&saved.1.expose_secret()));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn recovery_identifier_accepts_current_and_unexpired_aliases_only(owner: PgPool) {
    let rig = Rig::new(owner).await;
    let uid = rig.ops.as_uuid();
    let org = rig.org.as_uuid();
    for (alias, deadline) in [("oldlogin", "tomorrow"), ("expiredlogin", "yesterday")] {
        sqlx::query("INSERT INTO user_sign_in_ids(org_id,user_id,login,effective_date,reason_code,retired_at,alias_until)
                     VALUES($1,$2,$3,current_date,'RENAME',now()-interval '2 days',$4::text::timestamptz)")
            .bind(org).bind(uid).bind(alias).bind(deadline).execute(&rig.owner).await.unwrap();
    }
    for (slug, deadline) in [
        ("old-company", "tomorrow"),
        ("expired-company", "yesterday"),
    ] {
        sqlx::query(
            "INSERT INTO organization_domains(org_id,slug,retired_at,alias_until)
                      VALUES($1,$2,now()-interval '2 days',$3::text::timestamptz)",
        )
        .bind(org)
        .bind(slug)
        .bind(deadline)
        .execute(&rig.owner)
        .await
        .unwrap();
    }
    let (login, current_domain) = rig.ops_identifier.split_once('@').unwrap();
    for (input, domain, expected) in [
        (login, current_domain, Some(*uid)),
        ("OLDLOGIN", current_domain, Some(*uid)),
        (login, "old-company", Some(*uid)),
        ("oldlogin", "old-company", Some(*uid)),
        ("expiredlogin", current_domain, None),
        (login, "expired-company", None),
    ] {
        let actual: Option<Uuid> =
            sqlx::query_scalar("SELECT user_id FROM platform_resolve_recovery_identifier($1,$2)")
                .bind(input)
                .bind(domain)
                .fetch_optional(&rig.rt)
                .await
                .unwrap();
        assert_eq!(actual, expected);
    }
}
