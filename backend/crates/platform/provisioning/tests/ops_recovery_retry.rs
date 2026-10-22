// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "fixtures/ops_recovery.rs"]
mod fixture;
use console_platform_provisioning::{
    BootstrapCredentialStore, OpsRecoveryCommand as C, OpsRecoveryState,
};
use fixture::Harness;
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

/// Losing the once-shown code must require the full governed flow again, never reopen admin-otp.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn ops_recovery_lost_or_expired_issue_restarts_the_same_two_person_hold(pool: PgPool) {
    let h = Harness::new(pool, true, true).await;
    let first = h.approved().await;
    h.force_hold_elapse(first).await;
    let issued = h.vendor(h.a, first, C::Issue).await.unwrap();
    let facts =
        h.p.read_ops_recovery(&h.runtime, h.org, true, OffsetDateTime::now_utc())
            .await
            .unwrap();
    assert!(facts.ops_enrolled && facts.recovery_available && !facts.ops_has_passkey);
    assert!(
        BootstrapCredentialStore
            .redeem_otp(
                &h.runtime,
                issued.otp.as_ref().unwrap(),
                issued.expires_at.unwrap()
            )
            .await
            .is_err()
    );
    let second = h.open().await;
    let facts =
        h.p.read_ops_recovery(&h.runtime, h.org, true, OffsetDateTime::now_utc())
            .await
            .unwrap();
    assert_eq!(facts.state, Some(OpsRecoveryState::WaitingApproval));
    h.refusal(h.a, second, C::Issue, "ops_recovery_not_approved")
        .await;
    h.vendor(h.b, second, C::Approve).await.unwrap();
    h.refusal(h.a, second, C::Issue, "ops_recovery_hold_active")
        .await;
    h.force_hold_elapse(second).await;
    let replacement = h.vendor(h.a, second, C::Issue).await.unwrap();
    assert_ne!(issued.otp, replacement.otp);
    assert!(
        BootstrapCredentialStore
            .redeem_otp(
                &h.runtime,
                issued.otp.as_ref().unwrap(),
                OffsetDateTime::now_utc()
            )
            .await
            .is_err()
    );
    assert!(
        BootstrapCredentialStore
            .redeem_otp(
                &h.runtime,
                replacement.otp.as_ref().unwrap(),
                OffsetDateTime::now_utc()
            )
            .await
            .is_ok()
    );
    let codes:i64=sqlx::query_scalar("SELECT count(*) FROM auth_bootstrap_credentials WHERE user_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL").bind(h.ops.as_uuid()).fetch_one(&h.owner).await.unwrap();
    assert_eq!(codes, 1);
    let notices: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM notifications WHERE org_id=$1 AND category='tenant.ops_recovery'",
    )
    .bind(h.org.as_uuid())
    .fetch_one(&h.owner)
    .await
    .unwrap();
    assert_eq!(notices, 4);
    assert_ne!(first, second);
    assert_ne!(second, Uuid::nil());
}
