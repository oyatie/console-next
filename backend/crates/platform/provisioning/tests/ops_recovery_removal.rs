// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Prove `platform_remove_organization` cleanly removes a tenant holding
//! `ops_account_holders`, `recovery_contacts`, `recovery_codes`, and
//! `recovery_contact_challenges` under `console_rt` (`FORCE RLS`).

use console_kernel_core::{OrgId, UserId};
use console_platform_email::{StubEmailMode, StubEmailSender};
use console_platform_provisioning::ops_self_recovery::{
    RecoveryChannel, RecoveryContactCipher, generate_recovery_codes, issue_recovery_challenge,
    upsert_recovery_contact,
};
use console_platform_provisioning::{
    BootstrapCredentialStore, PlatformProvisioner, TenantRemovalOutcome,
};
use console_platform_test_support::runtime_role_pool;
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn guarded_tenant_removal_cascades_ops_holders_and_recovery_tables(owner: PgPool) {
    let rt = runtime_role_pool(&owner).await;
    let now = OffsetDateTime::now_utc();
    let prov = PlatformProvisioner::new(Duration::hours(1));
    let slug = format!("rm-rec-{}", &Uuid::new_v4().simple().to_string()[..8]);
    let created = prov
        .onboard_tenant(&rt, None, &slug, "Removable Tenant", now)
        .await
        .unwrap();
    let org = OrgId::from_uuid(created.organization.id);
    let ops = created.admin_user_id;

    let cipher = RecoveryContactCipher::dev_ephemeral().unwrap();
    let store = BootstrapCredentialStore::default();
    upsert_recovery_contact(
        &rt,
        &cipher,
        org,
        ops,
        RecoveryChannel::Email,
        "ops@rm.test",
        now,
    )
    .await
    .unwrap();
    generate_recovery_codes(&rt, &store, org, ops, now)
        .await
        .unwrap();
    let identifier: String = sqlx::query_scalar(
        "SELECT s.login || '@' || o.slug FROM user_sign_in_ids s JOIN organizations o ON o.id = s.org_id WHERE s.user_id = $1 AND s.retired_at IS NULL",
    )
    .bind(ops)
    .fetch_one(&owner)
    .await
    .unwrap();
    issue_recovery_challenge(
        &rt,
        &store,
        &cipher,
        &StubEmailSender::new(StubEmailMode::Test),
        &identifier,
        now,
    )
    .await
    .unwrap();

    let actor = console_platform_test_support::seed_active_user(
        &owner,
        *OrgId::platform().as_uuid(),
        "SUPER_ADMIN",
        "rm-actor",
    )
    .await;
    let outcome = prov
        .remove_tenant(&rt, Some(actor), *org.as_uuid(), now)
        .await
        .unwrap();
    assert_eq!(outcome, TenantRemovalOutcome::Removed);

    let leftover: i64 = sqlx::query_scalar(
        "SELECT (SELECT count(*) FROM ops_account_holders WHERE org_id = $1)
              + (SELECT count(*) FROM recovery_contacts WHERE org_id = $1)
              + (SELECT count(*) FROM recovery_codes WHERE org_id = $1)
              + (SELECT count(*) FROM recovery_contact_challenges WHERE org_id = $1)",
    )
    .bind(org.as_uuid())
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(leftover, 0);
    let _ = UserId::from_uuid(ops);
}
