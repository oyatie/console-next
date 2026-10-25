// SPDX-License-Identifier: LicenseRef-Proprietary

use super::*;

/// Issued OTPs use phone-readable Crockford base32 in two groups.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn issued_otp_is_ten_crockford_symbols_grouped_five_five(pool: PgPool) {
    let user_id = seed_user(&pool).await;
    let now = OffsetDateTime::now_utc();
    let issue = BootstrapCredentialStore
        .issue_for_zero_credential_user(
            &pool,
            None,
            user_id,
            OrgId::one(),
            now,
            Duration::hours(24),
        )
        .await
        .unwrap();

    let token = issue.token.as_str();
    let groups: Vec<_> = token.split('-').collect();
    assert_eq!(groups.len(), 2);
    assert!(groups.iter().all(|group| group.len() == 5));
    const ALLOWED: &str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    assert!(
        groups
            .iter()
            .all(|group| group.chars().all(|c| ALLOWED.contains(c))),
        "OTP must use only the documented alphabet, got {token:?}"
    );

    // The hash is stored, never the plaintext.
    let token_hash: Vec<u8> =
        sqlx::query("SELECT token_hash FROM auth_bootstrap_credentials WHERE id = $1")
            .bind(issue.credential_id)
            .fetch_one(&pool)
            .await
            .unwrap()
            .try_get("token_hash")
            .unwrap();
    assert_ne!(token_hash, token.as_bytes());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn legacy_codes_keep_redeeming_and_new_codes_accept_case_and_grouping(pool: PgPool) {
    let user_id = seed_user(&pool).await;
    let now = OffsetDateTime::now_utc();
    let store = BootstrapCredentialStore;
    let issue = store
        .issue_for_zero_credential_user(&pool, None, user_id, OrgId::one(), now, Duration::hours(1))
        .await
        .unwrap();

    for (stored, inputs) in [
        ("aB!9-_cD", vec!["aB!9-_cD", "aB!9-_cD"]),
        (
            "ABCDE-FGHJK",
            vec!["abcde-fghjk", "abcdefghjk", " abcde fghjk\n"],
        ),
    ] {
        sqlx::query("UPDATE auth_bootstrap_credentials SET token_hash=$1 WHERE id=$2")
            .bind(Sha256::digest(stored.as_bytes()).to_vec())
            .bind(issue.credential_id)
            .execute(&pool)
            .await
            .unwrap();
        for input in inputs {
            let redeemed = store.redeem_otp(&pool, input, now).await.unwrap();
            assert_eq!(redeemed.user_id, user_id);
            assert!(redeemed.requires_passkey_setup);
            assert!(redeemed.reusable);
            assert_eq!(redeemed.expires_at, issue.expires_at);
        }
        let expired = store.redeem_otp(&pool, stored, issue.expires_at).await;
        assert!(matches!(
            expired,
            Err(ProvisioningError::InvalidBootstrapCredential)
        ));
    }
    let consumed: Option<OffsetDateTime> =
        sqlx::query_scalar("SELECT consumed_at FROM auth_bootstrap_credentials WHERE id=$1")
            .bind(issue.credential_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(consumed, None, "cancelled setup leaves the code reusable");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn first_sign_in_code_refuses_registered_passkey_and_recovery_remains_single_use(
    pool: PgPool,
) {
    let user_id = seed_user(&pool).await;
    let now = OffsetDateTime::now_utc();
    let store = BootstrapCredentialStore;
    let issue = store
        .issue_for_zero_credential_user(&pool, None, user_id, OrgId::one(), now, Duration::hours(1))
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO auth_webauthn_credentials (user_id,credential_id,passkey_json,org_id) \
         VALUES ($1,'enrolled-before-consumption','{}',$2)",
    )
    .bind(user_id)
    .bind(*OrgId::one().as_uuid())
    .execute(&pool)
    .await
    .unwrap();
    let enrolled = store.redeem_otp(&pool, issue.token.as_str(), now).await;
    assert!(matches!(
        enrolled,
        Err(ProvisioningError::InvalidBootstrapCredential)
    ));

    sqlx::query("UPDATE auth_bootstrap_credentials SET single_use=true WHERE id=$1")
        .bind(issue.credential_id)
        .execute(&pool)
        .await
        .unwrap();
    let recovered = store
        .redeem_otp(&pool, issue.token.as_str(), now)
        .await
        .unwrap();
    assert!(!recovered.reusable);
    assert_eq!(recovered.expires_at, issue.expires_at);
    let replay = store.redeem_otp(&pool, issue.token.as_str(), now).await;
    assert!(matches!(
        replay,
        Err(ProvisioningError::InvalidBootstrapCredential)
    ));
}
