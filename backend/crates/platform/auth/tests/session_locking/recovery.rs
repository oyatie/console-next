// SPDX-License-Identifier: LicenseRef-Proprietary
//! fin-session-recovery: a revoked family keeps the recovery reason the client acts on.

use super::*;

#[sqlx::test(migrator = "MIGRATOR")]
async fn rotation_denies_account_deactivated_during_wait(owner: PgPool) {
    let user = user(&owner).await;
    let rt = runtime(&owner, "rotate-account-inactive").await;
    let first = issue(&rt, user).await;
    let family = first.family_id;
    let token = first.token_id;
    let (mut held, pid) = account(&owner, user).await;
    let task = tokio::spawn(async move {
        RefreshTokenStore
            .rotate(
                &rt,
                first.token.as_str(),
                OffsetDateTime::now_utc(),
                Duration::minutes(10),
                Duration::days(1),
            )
            .await
    });
    blocked(&owner, "rotate-account-inactive", pid).await;
    token_and_family_unlocked(&owner, token, family).await;
    sqlx::query("UPDATE users SET is_active=false WHERE id=$1")
        .bind(user)
        .execute(&mut *held)
        .await
        .unwrap();
    held.commit().await.unwrap();
    assert!(matches!(
        timeout(WAIT, task).await.unwrap().unwrap(),
        Err(RefreshTokenUseError::AccountDeactivated | RefreshTokenUseError::FamilyRevoked)
    ));
    let state:(i64,bool,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM auth_refresh_tokens WHERE family_id=$1),(SELECT used_at IS NULL AND replaced_by IS NULL FROM auth_refresh_tokens WHERE id=$2),(SELECT count(*) FROM audit_events WHERE actor=$3 AND action='auth.refresh')").bind(family).bind(token).bind(user).fetch_one(&owner).await.unwrap();
    assert_eq!(state, (1, true, 0));
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn deactivation_supersedes_an_earlier_passkey_reset(owner: PgPool) {
    let user = user(&owner).await;
    let rt = runtime(&owner, "rotate-reset-then-deactivate").await;
    let first = issue(&rt, user).await;
    sqlx::query("UPDATE auth_refresh_token_families SET revoked_at=clock_timestamp(),revoked_reason='credential_reset' WHERE id=$1")
        .bind(first.family_id).execute(&owner).await.unwrap();
    let rotate = || {
        RefreshTokenStore.rotate(
            &rt,
            first.token.as_str(),
            OffsetDateTime::now_utc(),
            Duration::minutes(10),
            Duration::days(1),
        )
    };
    assert_eq!(
        rotate().await.unwrap_err(),
        RefreshTokenUseError::PasskeyReset
    );
    sqlx::query("UPDATE users SET is_active=false WHERE id=$1")
        .bind(user)
        .execute(&owner)
        .await
        .unwrap();
    let reason: String =
        sqlx::query_scalar("SELECT revoked_reason FROM auth_refresh_token_families WHERE id=$1")
            .bind(first.family_id)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(reason, "credential_reset");
    assert_eq!(
        rotate().await.unwrap_err(),
        RefreshTokenUseError::AccountDeactivated
    );
    let state: (i64, bool, i64) = sqlx::query_as("SELECT (SELECT count(*) FROM auth_refresh_tokens WHERE family_id=$1),(SELECT used_at IS NULL AND replaced_by IS NULL FROM auth_refresh_tokens WHERE id=$2),(SELECT count(*) FROM audit_events WHERE actor=$3 AND action='auth.refresh')")
        .bind(first.family_id).bind(first.token_id).bind(user).fetch_one(&owner).await.unwrap();
    assert_eq!(state, (1, true, 0));
}
