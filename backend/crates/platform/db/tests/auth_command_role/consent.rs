// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrations = false)]
async fn auth_command_expand_preserves_populated_0231_database(pool: PgPool) {
    let through_0231 = Migrator {
        migrations: Cow::Owned(
            MIGRATOR
                .iter()
                .filter(|migration| migration.version <= 231)
                .cloned()
                .collect(),
        ),
        ..Migrator::DEFAULT
    };
    through_0231.run(&pool).await.unwrap();

    let company = Uuid::new_v4();
    let account = Uuid::new_v4();
    let otp = Uuid::new_v4();
    let family = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO organizations (id,slug,name) VALUES ($1,'auth-upgrade','Auth upgrade')",
    )
    .bind(company)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO users (id,display_name,org_id,roles) VALUES ($1,'Legacy account',$2,ARRAY['MEMBER'])")
        .bind(account)
        .bind(company)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO auth_bootstrap_credentials (id,user_id,token_hash,issued_at,expires_at,org_id) VALUES ($1,$2,$3,clock_timestamp(),clock_timestamp()+interval '1 hour',$4)")
        .bind(otp)
        .bind(account)
        .bind(vec![7_u8; 32])
        .bind(company)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO auth_refresh_token_families (id,user_id,created_at,org_id) VALUES ($1,$2,clock_timestamp(),$3)")
        .bind(family)
        .bind(account)
        .bind(company)
        .execute(&pool)
        .await
        .unwrap();

    // Later activity, ops-recovery OTP (single_use, redeemed_at) and consent-cache columns
    // postdate 0231; compare the original live state.
    let before: serde_json::Value = sqlx::query_scalar(
        "SELECT jsonb_build_object( \
         'account',(SELECT to_jsonb(a) FROM auth_security.account_state a WHERE account_id=$1), \
         'otp',(SELECT to_jsonb(b) - 'single_use' - 'redeemed_at' FROM auth_bootstrap_credentials b WHERE id=$2), \
         'family',(SELECT to_jsonb(f) - 'last_activity_at' - 'idle_timeout_minutes' - 'privacy_acceptance' FROM auth_refresh_token_families f WHERE id=$3))",
    )
    .bind(account)
    .bind(otp)
    .bind(family)
    .fetch_one(&pool)
    .await
    .unwrap();

    MIGRATOR.run(&pool).await.unwrap();

    let after: serde_json::Value = sqlx::query_scalar(
        "SELECT jsonb_build_object( \
         'account',(SELECT to_jsonb(a) FROM auth_security.account_state a WHERE account_id=$1), \
         'otp',(SELECT to_jsonb(b) - 'single_use' - 'redeemed_at' FROM auth_bootstrap_credentials b WHERE id=$2), \
         'family',(SELECT to_jsonb(f) - 'last_activity_at' - 'idle_timeout_minutes' - 'privacy_acceptance' FROM auth_refresh_token_families f WHERE id=$3))",
    )
    .bind(account)
    .bind(otp)
    .bind(family)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        after, before,
        "role expansion must not rewrite live auth state"
    );
    MIGRATOR.run(&pool).await.unwrap();
    let after_retry: serde_json::Value = sqlx::query_scalar(
        "SELECT jsonb_build_object( \
         'account',(SELECT to_jsonb(a) FROM auth_security.account_state a WHERE account_id=$1), \
         'otp',(SELECT to_jsonb(b) - 'single_use' - 'redeemed_at' FROM auth_bootstrap_credentials b WHERE id=$2), \
         'family',(SELECT to_jsonb(f) - 'last_activity_at' - 'idle_timeout_minutes' - 'privacy_acceptance' FROM auth_refresh_token_families f WHERE id=$3))",
    )
    .bind(account)
    .bind(otp)
    .bind(family)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(after_retry, after, "migration retry must not rewrite state");
    let consent: Option<serde_json::Value> = sqlx::query_scalar(
        "SELECT privacy_acceptance FROM auth_refresh_token_families WHERE id=$1",
    )
    .bind(family)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        consent.is_none(),
        "migration must not invent consent for an existing session"
    );
}
