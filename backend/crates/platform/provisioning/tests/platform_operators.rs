// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_kernel_core::{OrgId, UserId};
use console_platform_auth::{MobilePasskeyStepUpBinding, MobileStepUpActionKind};
use console_platform_provisioning::{
    BootstrapCredentialStore, InvitePlatformOperatorInput, PlatformOperatorStatus,
    PlatformOperatorStepUp, PlatformProvisioner, ProvisioningError,
};
use console_platform_test_support::{
    MIGRATOR, runtime_role_pool, seed_org_and_super_admin, soft_passkey::SoftKey,
};
use sqlx::{PgPool, Postgres, Transaction};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

async fn seed_platform_operator(owner: &PgPool) -> (UserId, SoftKey) {
    sqlx::query("INSERT INTO organizations (id, slug, name, status) VALUES ($1, 'platform', 'Platform', 'ARCHIVED') ON CONFLICT (id) DO NOTHING")
        .bind(OrgId::platform().as_uuid())
        .execute(owner)
        .await
        .unwrap();
    let user = UserId::new();
    sqlx::query("INSERT INTO users (id, display_name, roles, is_active, org_id) VALUES ($1, 'Primary Operator', ARRAY['SUPER_ADMIN'], true, $2)")
        .bind(user.as_uuid())
        .bind(OrgId::platform().as_uuid())
        .execute(owner)
        .await
        .unwrap();
    let key = SoftKey::enroll(owner, OrgId::platform(), user).await;
    (user, key)
}

async fn record_step_up(
    owner: &PgPool,
    tx: &mut Transaction<'_, Postgres>,
    actor: UserId,
    object_id: Uuid,
    payload_hash: String,
) -> Uuid {
    let ceremony_id = Uuid::new_v4();
    let cred_row: Uuid =
        sqlx::query_scalar("SELECT id FROM auth_webauthn_credentials WHERE user_id = $1 LIMIT 1")
            .bind(actor.as_uuid())
            .fetch_one(owner)
            .await
            .unwrap();
    let binding = MobilePasskeyStepUpBinding::bound(
        MobileStepUpActionKind::OperatorRecovery,
        object_id,
        payload_hash.clone(),
    );
    assert!(binding.validate().is_ok());
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(OrgId::platform().as_uuid().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO step_up_assertions (ceremony_id, org_id, user_id, credential_row_id, action_kind, object_id, payload_hash, user_verified) \
         VALUES ($1, $2, $3, $4, 'OPERATOR_RECOVERY', $5, $6, true)",
    )
    .bind(ceremony_id)
    .bind(OrgId::platform().as_uuid())
    .bind(actor.as_uuid())
    .bind(cred_row)
    .bind(object_id)
    .bind(payload_hash)
    .execute(tx.as_mut())
    .await
    .unwrap();
    ceremony_id
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn invite_reissue_redeem_consume_and_revoke_lifecycle(owner: PgPool) {
    let (actor, _key) = seed_platform_operator(&owner).await;
    let rt = runtime_role_pool(&owner).await;
    let provisioner = PlatformProvisioner::new(Duration::hours(24));
    let now = OffsetDateTime::now_utc();
    let b_id = Uuid::new_v4();

    let mut tx = rt.begin().await.unwrap();
    let assertion = record_step_up(
        &owner,
        &mut tx,
        actor,
        b_id,
        PlatformOperatorStepUp::invite_payload_hash(b_id, "Second Operator", Some("op.two"))
            .unwrap(),
    )
    .await;
    let invited = provisioner
        .invite_platform_operator_in_tx(
            &mut tx,
            actor,
            assertion,
            InvitePlatformOperatorInput {
                id: b_id,
                display_name: "Second Operator".into(),
                login: Some("op.two".into()),
            },
            now,
        )
        .await
        .unwrap();
    tx.commit().await.unwrap();

    assert_eq!(
        invited.operator.status,
        PlatformOperatorStatus::PendingEnrolment
    );
    assert_eq!(
        invited.operator.sign_in_id.as_deref(),
        Some("op.two@platform")
    );
    assert!(invited.invite_token.as_str().starts_with("cop_"));
    assert_eq!(
        format!("{:?}", invited.invite_token),
        "BootstrapToken([REDACTED])"
    );

    // Verify no raw token leaked into audit_events.
    let raw_leaks: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE after_snap::text LIKE $1")
            .bind(format!("%{}%", invited.invite_token.as_str()))
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(raw_leaks, 0);

    // Reissue invalidates the previous token.
    let mut tx = rt.begin().await.unwrap();
    let assertion = record_step_up(
        &owner,
        &mut tx,
        actor,
        b_id,
        PlatformOperatorStepUp::reissue_payload_hash(b_id).unwrap(),
    )
    .await;
    let reissued = provisioner
        .reissue_platform_operator_invite_in_tx(&mut tx, actor, assertion, b_id, now)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_ne!(reissued.invite_token, invited.invite_token);

    let err = BootstrapCredentialStore::default()
        .redeem_otp(&rt, invited.invite_token.as_str(), now)
        .await
        .unwrap_err();
    assert!(matches!(err, ProvisioningError::InvalidBootstrapCredential));

    // Bit-flipped token fails closed.
    let mut tampered = reissued.invite_token.as_str().to_owned();
    let last = tampered.pop().unwrap();
    tampered.push(if last == 'A' { 'B' } else { 'A' });
    let err = BootstrapCredentialStore::default()
        .redeem_otp(&rt, &tampered, now)
        .await
        .unwrap_err();
    assert!(matches!(err, ProvisioningError::InvalidBootstrapCredential));

    // Valid token redeems once and sets redeemed_at on platform_operator_invites.
    let mut tx = rt.begin().await.unwrap();
    let redeemed = BootstrapCredentialStore::default()
        .redeem_otp_in_tx(&mut tx, reissued.invite_token.as_str(), now)
        .await
        .unwrap();
    assert_eq!(redeemed.user_id, b_id);
    assert_eq!(redeemed.org_id, OrgId::platform());
    BootstrapCredentialStore::default()
        .consume_bound_credential_tx(
            &mut tx,
            OrgId::platform(),
            b_id,
            redeemed.source.credential_id,
            now,
        )
        .await
        .unwrap();
    tx.commit().await.unwrap();

    let (redeemed_at, accepted_at): (Option<OffsetDateTime>, Option<OffsetDateTime>) =
        sqlx::query_as(
            "SELECT redeemed_at, accepted_at FROM platform_operator_invites WHERE credential_id = $1",
        )
        .bind(redeemed.source.credential_id)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert!(redeemed_at.is_some());
    assert!(accepted_at.is_some());

    // Self-revoke refuses with cannot_revoke_self.
    let mut tx = rt.begin().await.unwrap();
    let assertion = record_step_up(
        &owner,
        &mut tx,
        actor,
        *actor.as_uuid(),
        PlatformOperatorStepUp::revoke_payload_hash(*actor.as_uuid(), Some("self")).unwrap(),
    )
    .await;
    let err = provisioner
        .revoke_platform_operator_in_tx(
            &mut tx,
            actor,
            assertion,
            *actor.as_uuid(),
            Some("self"),
            now,
        )
        .await
        .unwrap_err();
    assert!(matches!(
        err,
        ProvisioningError::PlatformOperator("cannot_revoke_self")
    ));
    tx.rollback().await.unwrap();

    // Revoking unkeyed B succeeds while actor remains active enrolled.
    let mut tx = rt.begin().await.unwrap();
    let assertion = record_step_up(
        &owner,
        &mut tx,
        actor,
        b_id,
        PlatformOperatorStepUp::revoke_payload_hash(b_id, Some("unused")).unwrap(),
    )
    .await;
    let revoked = provisioner
        .revoke_platform_operator_in_tx(&mut tx, actor, assertion, b_id, Some("unused"), now)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert!(!revoked.is_active);
    assert_eq!(revoked.status, PlatformOperatorStatus::Revoked);
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn cold_start_skips_when_any_active_super_admin_has_passkey_even_with_smaller_unkeyed_uuid(
    owner: PgPool,
) {
    sqlx::query("INSERT INTO organizations (id, slug, name, status) VALUES ($1, 'platform', 'Platform', 'ARCHIVED') ON CONFLICT (id) DO NOTHING")
        .bind(OrgId::platform().as_uuid())
        .execute(&owner)
        .await
        .unwrap();

    let enrolled_id = Uuid::parse_str("ffffffff-ffff-4fff-8fff-ffffffffffff").unwrap();
    let pending_smaller_id = Uuid::parse_str("00000000-0000-4000-8000-000000000001").unwrap();
    sqlx::query("INSERT INTO users (id, display_name, roles, is_active, org_id) VALUES ($1, 'Enrolled', ARRAY['SUPER_ADMIN'], true, $2)")
        .bind(enrolled_id)
        .bind(OrgId::platform().as_uuid())
        .execute(&owner)
        .await
        .unwrap();
    SoftKey::enroll(&owner, OrgId::platform(), UserId::from_uuid(enrolled_id)).await;

    sqlx::query("INSERT INTO users (id, display_name, roles, is_active, org_id) VALUES ($1, 'Pending Smaller UUID', ARRAY['SUPER_ADMIN'], true, $2)")
        .bind(pending_smaller_id)
        .bind(OrgId::platform().as_uuid())
        .execute(&owner)
        .await
        .unwrap();

    let rt = runtime_role_pool(&owner).await;
    let seeded = BootstrapCredentialStore::default()
        .seed_cold_start_credential(
            &rt,
            "coldstart-should-skip",
            Duration::hours(1),
            OffsetDateTime::now_utc(),
        )
        .await
        .unwrap();
    assert!(
        !seeded,
        "cold-start must skip whenever any active platform SUPER_ADMIN already holds a passkey"
    );

    let tenant_user = seed_org_and_super_admin(&owner, *OrgId::one().as_uuid(), "Tenant Op").await;
    assert_ne!(tenant_user.as_uuid(), &pending_smaller_id);
}
