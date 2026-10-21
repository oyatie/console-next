#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! regression (governance-02, r2): the only ops holder reset its own only
//! passkey; the session ended at once and the one-time code hid under the
//! 「다시 로그인」 dialog, locking the solo tenant out. A credential reset of
//! the caller's own account is now 409 `last_sign_in_path` before anything is
//! checked or written: the passkey stays, no code is minted, no session ends.

mod period_unlock_support;

use console_platform_test_support::soft_passkey::passkey_service;
use http::StatusCode;
use period_unlock_support::{admin, router, send};
use serde_json::json;
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_only_ops_holder_cannot_reset_its_own_passkeys(owner: PgPool) {
    let (service, issuer) = router(&owner).await;
    let ops = admin(&owner, &passkey_service(), &issuer, "운영").await;
    sqlx::query("UPDATE users SET is_tenant_ops = true WHERE id = $1")
        .bind(ops.id)
        .execute(&owner)
        .await
        .unwrap();
    let count = |sql: &'static str| {
        let owner = owner.clone();
        async move {
            sqlx::query_scalar::<_, i64>(sql)
                .bind(ops.id)
                .fetch_one(&owner)
                .await
                .unwrap()
        }
    };

    let body = json!({ "user_id": ops.id });
    let (status, refused) = send(
        &service,
        "/api/v1/auth/admin/credential-reset",
        &ops.token,
        None,
        body,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["error"]["code"], "last_sign_in_path");

    let passkeys = "SELECT count(*) FROM auth_webauthn_credentials WHERE user_id = $1";
    assert_eq!(count(passkeys).await, 1, "the passkey stays");
    let codes = "SELECT count(*) FROM auth_bootstrap_credentials WHERE user_id = $1";
    assert_eq!(count(codes).await, 0, "no code minted");
    let revoked = "SELECT count(*) FROM auth_refresh_token_families \
                   WHERE user_id = $1 AND revoked_at IS NOT NULL";
    assert_eq!(count(revoked).await, 0, "no session ended");
    let audit = "SELECT count(*) FROM audit_events WHERE action = 'auth.passkey.admin_reset' \
                 AND before_snap->>'user_id' = $1::text";
    assert_eq!(count(audit).await, 0, "no reset recorded");
}
