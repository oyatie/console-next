// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aws_lc_rs::digest::{SHA256, digest};
use console_kernel_core::OrgId;
use console_platform_provisioning::{BootstrapCredentialStore, OtpHmacKey, ProvisioningError};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

async fn seed_user(pool: &PgPool, name: &str) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO users (display_name, roles, is_active, org_id) VALUES ($1, ARRAY['MECHANIC'], true, $2) RETURNING id",
    )
    .bind(name)
    .bind(*OrgId::one().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn wrong_pepper_key_refuses_and_preserves_credential(pool: PgPool) {
    let user_id = seed_user(&pool, "Pepper User").await;
    let store_a = BootstrapCredentialStore::new(OtpHmacKey::from_bytes([0x11; 32], None).unwrap());
    let store_b = BootstrapCredentialStore::new(OtpHmacKey::from_bytes([0x22; 32], None).unwrap());
    let now = OffsetDateTime::now_utc();

    let issue = store_a
        .issue_for_zero_credential_user(&pool, None, user_id, OrgId::one(), now, Duration::hours(1))
        .await
        .unwrap();
    let stored_hash: Vec<u8> =
        sqlx::query_scalar("SELECT token_hash FROM auth_bootstrap_credentials WHERE id = $1")
            .bind(issue.credential_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_ne!(
        stored_hash,
        digest(&SHA256, issue.token.as_str().as_bytes()).as_ref()
    );

    let err = store_b
        .redeem_otp(&pool, issue.token.as_str(), now)
        .await
        .unwrap_err();
    assert!(matches!(err, ProvisioningError::InvalidBootstrapCredential));

    let redeemed = store_a
        .redeem_otp(&pool, issue.token.as_str(), now)
        .await
        .unwrap();
    assert_eq!(redeemed.user_id, user_id);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn tampered_otp_and_coldstart_otp_are_rejected(pool: PgPool) {
    let user_id = seed_user(&pool, "Tamper User").await;
    let store = BootstrapCredentialStore::new(OtpHmacKey::from_bytes([0x33; 32], None).unwrap());
    let now = OffsetDateTime::now_utc();

    let issue = store
        .issue_for_zero_credential_user(&pool, None, user_id, OrgId::one(), now, Duration::hours(1))
        .await
        .unwrap();
    let mut tampered: Vec<char> = issue.token.as_str().chars().collect();
    tampered[0] = if tampered[0] == 'A' { 'B' } else { 'A' };
    let tampered_str: String = tampered.into_iter().collect();
    assert!(matches!(
        store.redeem_otp(&pool, &tampered_str, now).await,
        Err(ProvisioningError::InvalidBootstrapCredential)
    ));

    assert!(
        store
            .seed_cold_start_credential(&pool, "coldstart-secret-1", Duration::hours(1), now)
            .await
            .unwrap()
    );
    assert!(matches!(
        store.redeem_otp(&pool, "coldstart-secret-2", now).await,
        Err(ProvisioningError::InvalidBootstrapCredential)
    ));
    assert!(
        store
            .redeem_otp(&pool, "coldstart-secret-1", now)
            .await
            .is_ok()
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn canonicalized_v2_and_legacy_v1_redeem_once_and_reject_replay(pool: PgPool) {
    let user_a = seed_user(&pool, "Canonical User").await;
    let user_b = seed_user(&pool, "Legacy User").await;
    let store = BootstrapCredentialStore::new(OtpHmacKey::from_bytes([0x44; 32], None).unwrap());
    let now = OffsetDateTime::now_utc();

    let issue = store
        .issue_for_zero_credential_user(&pool, None, user_a, OrgId::one(), now, Duration::hours(1))
        .await
        .unwrap();
    let compact = issue.token.as_str().replace('-', "").to_ascii_lowercase();
    let noisy = format!("  {} {} \n", &compact[..5], &compact[5..]);
    let redeemed = store.redeem_otp(&pool, &noisy, now).await.unwrap();
    assert_eq!(redeemed.user_id, user_a);
    assert!(matches!(
        store.redeem_otp(&pool, issue.token.as_str(), now).await,
        Err(ProvisioningError::InvalidBootstrapCredential)
    ));

    let v1_otp = "23456-789AB";
    sqlx::query(
        "INSERT INTO auth_bootstrap_credentials (id, user_id, token_hash, issued_at, expires_at, org_id) VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(Uuid::new_v4())
    .bind(user_b)
    .bind(digest(&SHA256, v1_otp.as_bytes()).as_ref().to_vec())
    .bind(now)
    .bind(now + Duration::hours(1))
    .bind(*OrgId::one().as_uuid())
    .execute(&pool)
    .await
    .unwrap();
    let v1_redeemed = store.redeem_otp(&pool, "23456 789ab", now).await.unwrap();
    assert_eq!(v1_redeemed.user_id, user_b);
    assert!(matches!(
        store.redeem_otp(&pool, v1_otp, now).await,
        Err(ProvisioningError::InvalidBootstrapCredential)
    ));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn otp_hmac_key_rotation_accepts_prev_key_and_issues_under_active_key(pool: PgPool) {
    let user_old = seed_user(&pool, "Old Key User").await;
    let user_new = seed_user(&pool, "New Key User").await;
    let key_old = [0x55; 32];
    let key_new = [0x66; 32];
    let store_old = BootstrapCredentialStore::new(OtpHmacKey::from_bytes(key_old, None).unwrap());
    let store_rotated =
        BootstrapCredentialStore::new(OtpHmacKey::from_bytes(key_new, Some(key_old)).unwrap());
    let now = OffsetDateTime::now_utc();

    let old_issue = store_old
        .issue_for_zero_credential_user(
            &pool,
            None,
            user_old,
            OrgId::one(),
            now,
            Duration::hours(1),
        )
        .await
        .unwrap();
    let redeemed = store_rotated
        .redeem_otp(&pool, old_issue.token.as_str(), now)
        .await
        .unwrap();
    assert_eq!(redeemed.user_id, user_old);
    assert!(matches!(
        store_rotated
            .redeem_otp(&pool, old_issue.token.as_str(), now)
            .await,
        Err(ProvisioningError::InvalidBootstrapCredential)
    ));

    let new_issue = store_rotated
        .issue_for_zero_credential_user(
            &pool,
            None,
            user_new,
            OrgId::one(),
            now,
            Duration::hours(1),
        )
        .await
        .unwrap();
    assert!(matches!(
        store_old
            .redeem_otp(&pool, new_issue.token.as_str(), now)
            .await,
        Err(ProvisioningError::InvalidBootstrapCredential)
    ));
    assert_eq!(
        store_rotated
            .redeem_otp(&pool, new_issue.token.as_str(), now)
            .await
            .unwrap()
            .user_id,
        user_new
    );
}
