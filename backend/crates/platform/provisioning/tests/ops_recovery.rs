// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "fixtures/ops_recovery.rs"]
mod fixture;
use console_kernel_core::OrgId;
use console_platform_provisioning::{
    BootstrapCredentialStore, OpsRecoveryCommand as C, OpsRecoveryState, ProvisioningError,
};
use console_platform_test_support::{
    seed_active_user,
    soft_passkey::{SoftKey, passkey_service},
};
use fixture::*;
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn ops_recovery_no_second_operator(pool: PgPool) {
    let h = Harness::new(pool, false, true).await;
    h.refusal(
        h.a,
        Uuid::new_v4(),
        open(),
        "ops_recovery_no_second_operator",
    )
    .await;
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn ops_recovery_not_enrolled(pool: PgPool) {
    let h = Harness::new(pool, true, false).await;
    h.refusal(h.a, Uuid::new_v4(), open(), "ops_recovery_not_enrolled")
        .await;
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn ops_recovery_already_open(pool: PgPool) {
    let h = Harness::new(pool, true, true).await;
    h.open().await;
    h.refusal(h.a, Uuid::new_v4(), open(), "ops_recovery_already_open")
        .await;
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn ops_recovery_sod_requester(pool: PgPool) {
    let h = Harness::new(pool, true, true).await;
    h.refusal(
        h.a,
        h.open().await,
        C::Approve,
        "ops_recovery_sod_requester",
    )
    .await;
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn ops_recovery_shared_authenticator(pool: PgPool) {
    let h = Harness::new(pool, true, true).await;
    let id = h.open().await;
    let result = h
        .command_with_credential(
            h.b,
            OrgId::platform(),
            id,
            C::Approve,
            h.credential(h.a).await,
        )
        .await;
    code(result, "ops_recovery_shared_authenticator");
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn ops_recovery_not_approved(pool: PgPool) {
    let h = Harness::new(pool, true, true).await;
    h.refusal(h.a, h.open().await, C::Issue, "ops_recovery_not_approved")
        .await;
    assert_eq!(h.recovery_codes().await, 0);
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn ops_recovery_hold_active(pool: PgPool) {
    let h = Harness::new(pool, true, true).await;
    h.refusal(
        h.a,
        h.approved().await,
        C::Issue,
        "ops_recovery_hold_active",
    )
    .await;
    assert_eq!(h.recovery_codes().await, 0);
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn ops_recovery_solo_lifecycle_replaces_credentials_sessions_and_redeems_once(pool: PgPool) {
    let mut h = Harness::new(pool, true, true).await;
    let family = h.seed_session().await;
    let id = h.approved().await;
    let notified: i64 = sqlx::query_scalar("SELECT (after_snap->>'notified_accounts')::bigint FROM audit_events WHERE org_id=$1 AND action='platform.tenant.ops_recovery.open'")
        .bind(h.org.as_uuid()).fetch_one(&h.owner).await.unwrap();
    assert_eq!(notified, 1);
    h.force_hold_elapse(id).await;
    let result = h.vendor(h.a, id, C::Issue).await.unwrap();
    let token = result.otp.unwrap();
    let (family_dead, token_dead): (bool, bool) = sqlx::query_as("SELECT f.revoked_at IS NOT NULL,t.revoked_at IS NOT NULL FROM auth_refresh_token_families f JOIN auth_refresh_tokens t ON t.family_id=f.id WHERE f.id=$1")
        .bind(family).fetch_one(&h.owner).await.unwrap();
    assert!(family_dead && token_dead);
    let proof = h.old_key.as_mut().unwrap().step_up(&h.owner).await;
    assert!(
        login(&h.runtime, proof).await.is_err(),
        "lost key cannot sign in"
    );
    let redeemed = BootstrapCredentialStore
        .redeem_otp(&h.runtime, &token, OffsetDateTime::now_utc())
        .await
        .unwrap();
    assert_eq!(redeemed.user_id, *h.ops.as_uuid());
    assert!(redeemed.requires_passkey_setup);
    let (single_use, redeemed_at, consumed_at): (
        bool,
        Option<OffsetDateTime>,
        Option<OffsetDateTime>,
    ) = sqlx::query_as(
        "SELECT single_use,redeemed_at,consumed_at FROM auth_bootstrap_credentials WHERE id=$1",
    )
    .bind(redeemed.source.credential_id)
    .fetch_one(&h.owner)
    .await
    .unwrap();
    assert!(single_use && redeemed_at.is_some() && consumed_at.is_none());
    assert!(matches!(
        BootstrapCredentialStore
            .redeem_otp(&h.runtime, &token, OffsetDateTime::now_utc())
            .await,
        Err(ProvisioningError::InvalidBootstrapCredential)
    ));
    let facts =
        h.p.read_ops_recovery(&h.runtime, h.org, true, OffsetDateTime::now_utc())
            .await
            .unwrap();
    assert!(facts.ops_enrolled);
    assert!(!facts.ops_has_passkey);
    let mut replacement = SoftKey::enroll(&h.owner, h.org, h.ops).await;
    assert!(
        login(&h.runtime, replacement.step_up(&h.owner).await)
            .await
            .is_ok()
    );
    h.assert_completed(id, &token).await;
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn ops_recovery_notices_reach_every_active_tenant_account(pool: PgPool) {
    let h = Harness::new(pool, true, true).await;
    let member = seed_active_user(&h.owner, *h.org.as_uuid(), "MEMBER", "recipient").await;
    let inactive = seed_active_user(&h.owner, *h.org.as_uuid(), "MEMBER", "retired").await;
    sqlx::query("UPDATE users SET is_active=false WHERE id=$1")
        .bind(inactive.as_uuid())
        .execute(&h.owner)
        .await
        .unwrap();
    let id = h.approved().await;
    h.force_hold_elapse(id).await;
    h.vendor(h.a, id, C::Issue).await.unwrap();
    for (user, expected) in [(h.ops, 2), (member, 2), (inactive, 0)] {
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM notifications WHERE org_id=$1 AND recipient_user_id=$2 AND category='tenant.ops_recovery'")
            .bind(h.org.as_uuid()).bind(user.as_uuid()).fetch_one(&h.owner).await.unwrap();
        assert_eq!(count, expected);
    }
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn ops_recovery_cancelled_by_holder_with_remaining_key_never_issues(pool: PgPool) {
    let h = Harness::new(pool, true, true).await;
    let mut held = SoftKey::enroll(&h.owner, h.org, h.ops).await;
    let id = h.approved().await;
    assert!(
        login(&h.runtime, held.step_up(&h.owner).await)
            .await
            .is_ok()
    );
    let cancel = C::Cancel {
        reason: "Holder retains another device".into(),
    };
    h.command(h.ops, h.org, id, cancel).await.unwrap();
    h.force_hold_elapse(id).await;
    h.refusal(h.a, id, C::Issue, "ops_recovery_cancelled").await;
    assert_eq!(h.recovery_codes().await, 0);
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn ops_recovery_foreign_tenant_and_third_vendor_are_refused(pool: PgPool) {
    let h = Harness::new(pool, true, true).await;
    let id = h.approved().await;
    let other = OrgId::from_uuid(Uuid::new_v4());
    let foreign = console_platform_test_support::seed_org_and_super_admin(
        &h.owner,
        *other.as_uuid(),
        "foreign",
    )
    .await;
    SoftKey::enroll(&h.owner, other, foreign).await;
    let result = h
        .command(
            foreign,
            other,
            id,
            C::Cancel {
                reason: "No authority".into(),
            },
        )
        .await;
    assert!(matches!(result, Err(ProvisioningError::NotFound(_))));
    let third = seed_active_user(
        &h.owner,
        *OrgId::platform().as_uuid(),
        "SUPER_ADMIN",
        "third",
    )
    .await;
    SoftKey::enroll(&h.owner, OrgId::platform(), third).await;
    h.force_hold_elapse(id).await;
    h.refusal(third, id, C::Issue, "forbidden").await;
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn ops_recovery_concurrent_issue_mints_exactly_one_secret(pool: PgPool) {
    let h = Harness::new(pool, true, true).await;
    let id = h.approved().await;
    h.force_hold_elapse(id).await;
    let (a, b) = tokio::join!(h.vendor(h.a, id, C::Issue), h.vendor(h.b, id, C::Issue));
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert_eq!(h.recovery_codes().await, 1);
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn ops_recovery_code_expires_at_the_configured_ttl(pool: PgPool) {
    let h = Harness::new(pool, true, true).await;
    let id = h.approved().await;
    h.force_hold_elapse(id).await;
    let result = h.vendor(h.a, id, C::Issue).await.unwrap();
    h.assert_expiry(id, result.otp.as_ref().unwrap()).await;
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn ops_recovery_tenant_read_redacts_proofing_evidence(pool: PgPool) {
    let h = Harness::new(pool, true, true).await;
    h.open().await;
    let read =
        h.p.read_ops_recovery(&h.runtime, h.org, false, OffsetDateTime::now_utc())
            .await
            .unwrap();
    assert_eq!(read.state, Some(OpsRecoveryState::WaitingApproval));
    assert!(read.ops_enrolled && read.second_operator_available);
    let r = read.request.unwrap();
    assert!(
        r.authoriser_name.is_none()
            && r.evidence_ref.is_none()
            && r.proofing_method.is_none()
            && r.authoriser_role.is_none()
    );
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn ops_recovery_regression_pin_enrolled_reissue_stays_closed(pool: PgPool) {
    let h = Harness::new(pool, true, true).await;
    let result =
        h.p.reissue_tenant_admin_otp(
            &h.runtime,
            Some(h.a),
            *h.org.as_uuid(),
            OffsetDateTime::now_utc(),
        )
        .await;
    assert!(matches!(
        result,
        Err(ProvisioningError::UserAlreadyHasPasskey)
    ));
}
async fn login(
    pool: &PgPool,
    proof: serde_json::Value,
) -> Result<Uuid, console_platform_auth::AuthError> {
    let result = passkey_service()
        .finish_authentication(
            pool,
            serde_json::from_value(proof["ceremony_id"].clone()).unwrap(),
            serde_json::from_value(proof["credential"].clone()).unwrap(),
        )
        .await?;
    Ok(result.user_id)
}
