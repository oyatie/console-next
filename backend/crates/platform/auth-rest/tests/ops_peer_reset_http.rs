// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Live Postgres HTTP verification for ops-holder peer credential reset
//! (`delivered_to_recovery_contact`, zero screen OTP), commitment-tag tamper
//! rejection, and suspended-tenant non-cancellation.

#[path = "fixtures/ops_self_recovery_rig.rs"]
mod rig;

use axum::http::{Method, StatusCode};
use console_kernel_core::{OrgId, UserId};
use console_platform_auth_rest::{
    ADMIN_CREDENTIAL_RESET_PATH, PASSKEY_LOGIN_FINISH_PATH, PASSKEY_LOGIN_START_PATH,
    PRIVACY_CONSENT_ACCEPT_PATH, PRIVACY_CONSENT_STATUS_PATH,
};
use console_platform_db::with_org_conn;
use console_platform_provisioning::ops_self_recovery::{
    RecoveryChannel, decrypt_recovery_contact_tx, generate_recovery_codes,
    issue_recovery_challenge, upsert_recovery_contact,
};
use console_platform_provisioning::{BootstrapCredentialStore, ProvisioningError};
use console_platform_test_support::soft_passkey::SoftKey;
use rig::Rig;
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

async fn login_and_consent(rig: &Rig, identifier: &str, key: &mut SoftKey) -> String {
    let (st, start) = rig
        .call(
            Method::POST,
            PASSKEY_LOGIN_START_PATH,
            None,
            Some(json!({ "identifier": identifier })),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{start}");
    let (st_fin, fin) = rig
        .call(
            Method::POST,
            PASSKEY_LOGIN_FINISH_PATH,
            None,
            Some(json!({ "ceremony_id": start["ceremony_id"], "credential": key.assert(&start["challenge"]).unwrap() })),
        )
        .await;
    assert_eq!(st_fin, StatusCode::OK, "{fin}");
    let jwt = fin["access_token"].as_str().unwrap().to_owned();
    let (_, doc) = rig
        .call(
            Method::POST,
            PRIVACY_CONSENT_STATUS_PATH,
            Some(&jwt),
            Some(json!({})),
        )
        .await;
    let (st_acc, acc) = rig
        .call(
            Method::POST,
            PRIVACY_CONSENT_ACCEPT_PATH,
            Some(&jwt),
            Some(json!({
                "privacy": doc["privacy"],
                "terms": doc["terms"],
                "privacy_collection": true,
                "terms_of_service": true
            })),
        )
        .await;
    assert_eq!(st_acc, StatusCode::OK, "{acc}");
    jwt
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn peer_ops_reset_never_returns_screen_otp_and_suspended_tenant_never_cancels_recovery(
    owner: PgPool,
) {
    let rig = Rig::new(owner).await;
    let org = rig.org;
    let ops1 = rig.ops;
    let mut key1 = SoftKey::enroll(&rig.owner, org, ops1).await;

    let ops2_uuid: Uuid = sqlx::query_scalar(
        "INSERT INTO users (display_name, roles, org_id, is_active, is_tenant_ops) VALUES ('Second Ops Holder', '{}', $1, true, true) RETURNING id",
    )
    .bind(org.as_uuid())
    .fetch_one(&rig.owner)
    .await
    .unwrap();
    let mut key2 = SoftKey::enroll(&rig.owner, org, UserId::from_uuid(ops2_uuid)).await;

    let admin_uuid: Uuid = sqlx::query_scalar(
        "INSERT INTO users (display_name, roles, org_id, is_active, is_tenant_ops) VALUES ('Regular Admin', ARRAY['SUPER_ADMIN'], $1, true, false) RETURNING id",
    )
    .bind(org.as_uuid())
    .fetch_one(&rig.owner)
    .await
    .unwrap();
    let mut admin_key = SoftKey::enroll(&rig.owner, org, UserId::from_uuid(admin_uuid)).await;

    upsert_recovery_contact(
        &rig.rt,
        &rig.cipher,
        org,
        ops2_uuid,
        RecoveryChannel::Email,
        "holder2@example.com",
        OffsetDateTime::now_utc(),
    )
    .await
    .unwrap();

    let admin_login: String = sqlx::query_scalar(
        "SELECT s.login || '@' || o.slug FROM user_sign_in_ids s JOIN organizations o ON o.id = s.org_id WHERE s.user_id = $1 AND s.retired_at IS NULL",
    )
    .bind(admin_uuid)
    .fetch_one(&rig.owner)
    .await
    .unwrap();
    let adm_jwt = login_and_consent(&rig, &admin_login, &mut admin_key).await;
    let adm_step = admin_key.step_up(&rig.owner).await;
    let (st_forbid, body_forbid) = rig
        .call(
            Method::POST,
            ADMIN_CREDENTIAL_RESET_PATH,
            Some(&adm_jwt),
            Some(json!({ "user_id": ops2_uuid, "step_up": adm_step })),
        )
        .await;
    assert_eq!(
        (st_forbid, body_forbid["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("ops_holder_only"))
    );

    let ops1_jwt = login_and_consent(&rig, &rig.ops_identifier, &mut key1).await;
    let ops1_step = key1.step_up(&rig.owner).await;
    let (st_reset, body_reset) = rig
        .call(
            Method::POST,
            ADMIN_CREDENTIAL_RESET_PATH,
            Some(&ops1_jwt),
            Some(json!({ "user_id": ops2_uuid, "step_up": ops1_step })),
        )
        .await;
    assert_eq!(st_reset, StatusCode::OK, "{body_reset}");
    assert_eq!(body_reset["delivered_to_recovery_contact"], true);
    assert_eq!(
        body_reset["otp"], "",
        "peer ops reset must never return OTP on screen"
    );
    let (sent_to, sent_otp) = rig.mailer.0.lock().unwrap().last().unwrap().clone();
    assert_eq!(sent_to, "holder2@example.com");
    let redeemed = BootstrapCredentialStore::default()
        .redeem_otp(&rig.rt, &sent_otp, OffsetDateTime::now_utc())
        .await
        .unwrap();
    assert_eq!(redeemed.user_id, ops2_uuid);
    let _ = &mut key2;

    sqlx::query("UPDATE recovery_contacts SET commitment_tag = decode(repeat('ff', 32), 'hex') WHERE org_id = $1 AND user_id = $2")
        .bind(org.as_uuid())
        .bind(ops2_uuid)
        .execute(&rig.owner)
        .await
        .unwrap();
    let c_clone = rig.cipher.clone();
    let tamper_res: Result<_, ProvisioningError> = with_org_conn(&rig.rt, org, move |tx| {
        Box::pin(async move { decrypt_recovery_contact_tx(tx, &c_clone, org, ops2_uuid).await })
    })
    .await;
    assert!(
        tamper_res.is_err(),
        "tampered commitment_tag must fail AEAD open"
    );

    let vendor = console_platform_test_support::seed_active_user(
        &rig.owner,
        *OrgId::platform().as_uuid(),
        "SUPER_ADMIN",
        "vendor-susp",
    )
    .await;
    let _vendor_key = SoftKey::enroll(&rig.owner, OrgId::platform(), vendor).await;
    let vendor_cred: Uuid =
        sqlx::query_scalar("SELECT id FROM auth_webauthn_credentials WHERE user_id = $1 LIMIT 1")
            .bind(vendor.as_uuid())
            .fetch_one(&rig.owner)
            .await
            .unwrap();
    let req_id = Uuid::new_v4();
    let open_assertion = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO step_up_assertions (ceremony_id, org_id, user_id, credential_row_id, action_kind, object_id, payload_hash, user_verified)
         VALUES ($1, $2, $3, $4, 'OPERATOR_RECOVERY', $5, repeat('b', 64), true)",
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
         VALUES ($1, $2, $3, $4, now(), 'REPRESENTATIVE', 'Rep', 'TEST', 'ev-susp', $5)",
    )
    .bind(org.as_uuid())
    .bind(req_id)
    .bind(ops1.as_uuid())
    .bind(vendor.as_uuid())
    .bind(open_assertion)
    .execute(&rig.owner)
    .await
    .unwrap();

    upsert_recovery_contact(
        &rig.rt,
        &rig.cipher,
        org,
        *ops1.as_uuid(),
        RecoveryChannel::Email,
        "holder1@example.com",
        OffsetDateTime::now_utc(),
    )
    .await
    .unwrap();
    let batch = generate_recovery_codes(
        &rig.rt,
        &BootstrapCredentialStore::default(),
        org,
        *ops1.as_uuid(),
        OffsetDateTime::now_utc(),
    )
    .await
    .unwrap();
    issue_recovery_challenge(
        &rig.rt,
        &BootstrapCredentialStore::default(),
        &rig.cipher,
        &rig.mailer,
        &rig.ops_identifier,
        OffsetDateTime::now_utc(),
    )
    .await
    .unwrap();
    let susp_contact_code = rig.mailer.0.lock().unwrap().last().unwrap().1.clone();

    sqlx::query("UPDATE organizations SET status = 'SUSPENDED' WHERE id = $1")
        .bind(org.as_uuid())
        .execute(&rig.owner)
        .await
        .unwrap();
    let (st_susp, body_susp): (StatusCode, Value) = rig
        .call(
            Method::POST,
            "/api/v1/auth/recovery/redeem",
            None,
            Some(json!({ "recovery_code": batch.codes[0], "contact_code": susp_contact_code })),
        )
        .await;
    assert_eq!(
        (st_susp, body_susp["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("tenant_inactive"))
    );
    let (still_open, unconsumed): (bool, bool) = sqlx::query_as(
        "SELECT (SELECT cancelled_at IS NULL FROM ops_recovery_requests WHERE org_id = $1 AND id = $2),
                (SELECT consumed_at IS NULL FROM recovery_codes WHERE org_id = $1 AND user_id = $3 AND code_index = 1 AND revoked_at IS NULL)",
    )
    .bind(org.as_uuid())
    .bind(req_id)
    .bind(ops1.as_uuid())
    .fetch_one(&rig.owner)
    .await
    .unwrap();
    assert!(
        still_open && unconsumed,
        "suspended tenant must rollback recovery code consumption and never cancel open recovery"
    );
}
