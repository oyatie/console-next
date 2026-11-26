// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[path = "../../test_support/governed_erase.rs"]
mod governed_erase;
#[path = "support/credential_reseal_helpers.rs"]
mod helpers;
#[path = "support/rrn_blind_index.rs"]
mod rrn_support;
#[path = "support/tenant_s3_ev_seed.rs"]
mod s3_ev_seed;
#[path = "support/tenant_shred_assertions.rs"]
mod shred_assertions;
#[path = "support/tenant_crypto_shred.rs"]
mod shred_support;

use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use console_app::mail_cipher::TenantEnvMailCipher;
use console_comms_adapter_postgres::PgMailStore;
use console_comms_application::{Aad, CredentialCipher, MailStore};
use console_comms_credential_cipher::EnvelopeCredentialCipher;
use console_hr_adapter_postgres::HrService;
use console_hr_domain::import::rrn_value::{Rrn, RrnVault};
use console_kernel_core::OrgId;
use console_platform_crypto::{TenantDekMode, TenantKeyScope};
use console_platform_db::tenant_keys::PgTenantKeyStore;
use console_platform_provisioning::PlatformProvisioner;
use console_platform_request_context::CURRENT_ORG;
use console_platform_test_support::seed_org_and_super_admin;
use helpers::{LogSink, keyring_json, reveal_with_step_up, seed_mail_account, seed_rrn_row};
use rrn_support::{TestEnvVault, seed_employee, seed_import_run, seed_tenant};
use s3_ev_seed::seed_all_nine_s3_tables;
use shred_assertions::{
    ShreddedTenant, assert_cold_pitr_fails_closed, assert_shredded_fail_closed_all_versions,
    seal_pre_shred_legacy_envelopes,
};
use shred_support::{
    assert_all_nine_s3_outbox_drain, assert_console_rt_cannot_insert_shredded,
    assert_shredded_triggers_and_witness, build_env_vault, force_role_pool, seed_staged_rrn,
};
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn two_operator_crypto_shred_survives_pitr_and_cleans_s3(owner: PgPool) {
    let ring = keyring_json("k1", &[("k1", 0x41)]);
    let h_b64 = BASE64.encode([0x42u8; 32]);
    let dummy_v = TestEnvVault::from_keyrings(Some(&ring), None, None, Some(&h_b64));
    let a = seed_tenant(&owner, "shred-a", dummy_v.clone()).await;
    let b = seed_tenant(&owner, "shred-b", dummy_v).await;

    let store = Arc::new(PgTenantKeyStore::new(TenantDekMode::Active));
    let vault_a = build_env_vault(a.rt.clone(), &ring, &h_b64, store.clone());
    let vault_b = build_env_vault(b.rt.clone(), &ring, &h_b64, store.clone());
    let mail_base = Arc::new(
        EnvelopeCredentialCipher::from_owned_env_values(Some(ring.clone()), None)
            .unwrap()
            .unwrap(),
    );
    let mail_a_cipher = TenantEnvMailCipher::new(mail_base.clone(), a.rt.clone());
    let mail_b_cipher = TenantEnvMailCipher::new(mail_base.clone(), b.rt.clone());

    let emp_a = seed_employee(&owner, a.org_uuid, "SA-1", "Target").await;
    let emp_b = seed_employee(&owner, b.org_uuid, "SB-1", "Survivor").await;
    let rrn_a = Rrn::parse("900101-1234567").unwrap();
    let rrn_b = Rrn::parse("880202-2345678").unwrap();
    let sealed_a = vault_a
        .scoped_for_org(a.org_uuid)
        .await
        .unwrap()
        .unwrap()
        .seal(a.org_uuid, &rrn_a)
        .unwrap();
    let sealed_b = vault_b
        .scoped_for_org(b.org_uuid)
        .await
        .unwrap()
        .unwrap()
        .seal(b.org_uuid, &rrn_b)
        .unwrap();
    assert_eq!(
        sealed_a.kek_id.as_deref(),
        Some(format!("tdek:{}:rrn:v1", a.org_uuid).as_str())
    );
    seed_rrn_row(&owner, a.org_uuid, emp_a, *a.actor.as_uuid(), &sealed_a).await;
    seed_rrn_row(&owner, b.org_uuid, emp_b, *b.actor.as_uuid(), &sealed_b).await;

    let run_a = seed_import_run(&owner, a.org_uuid).await;
    let staged_a = vault_a
        .scoped_for_org(a.org_uuid)
        .await
        .unwrap()
        .unwrap()
        .seal(a.org_uuid, &rrn_a)
        .unwrap();
    let run_b = seed_import_run(&owner, b.org_uuid).await;
    let staged_b = vault_b
        .scoped_for_org(b.org_uuid)
        .await
        .unwrap()
        .unwrap()
        .seal(b.org_uuid, &rrn_b)
        .unwrap();
    seed_staged_rrn(&owner, a.org_uuid, run_a, "s-a", &staged_a).await;
    seed_staged_rrn(&owner, b.org_uuid, run_b, "s-b", &staged_b).await;

    let mail_a_scoped = mail_a_cipher
        .scoped_for_org(a.org_uuid)
        .await
        .unwrap()
        .unwrap();
    let mail_b_scoped = mail_b_cipher
        .scoped_for_org(b.org_uuid)
        .await
        .unwrap()
        .unwrap();
    let kms_a = store
        .load_scope_for_org(
            &a.rt,
            a.org,
            TenantKeyScope::Mail,
            Arc::clone(mail_base.kms_provider()),
        )
        .await
        .unwrap();
    let kms_b = store
        .load_scope_for_org(
            &b.rt,
            b.org,
            TenantKeyScope::Mail,
            Arc::clone(mail_base.kms_provider()),
        )
        .await
        .unwrap();
    let env_mail_a = mail_base.with_tenant_kms(Arc::new(kms_a));
    let env_mail_b = mail_base.with_tenant_kms(Arc::new(kms_b));
    let acc_a = seed_mail_account(&owner, a.org, a.actor, "a@ex.test", &env_mail_a, 3, 3).await;
    let acc_b = seed_mail_account(&owner, b.org, b.actor, "b@ex.test", &env_mail_b, 3, 3).await;

    let hr_a = HrService::new(a.rt.clone()).with_rrn_vault(Some(vault_a.clone()));
    assert_eq!(
        reveal_with_step_up(
            &owner,
            &hr_a,
            a.org,
            a.actor,
            a.principal.clone(),
            emp_a,
            vault_a.as_ref()
        )
        .await,
        "900101-1234567"
    );
    let stored_a = CURRENT_ORG
        .scope(a.org, PgMailStore::new(a.rt.clone()).get_account())
        .await
        .unwrap()
        .unwrap();
    let aad_a = Aad {
        org_id: &a.org.to_string(),
        account_id: &acc_a.to_string(),
        field: "smtp_password",
    };
    assert!(
        mail_a_scoped
            .decrypt(&stored_a.smtp_password, aad_a)
            .is_ok()
    );
    assert_eq!(
        env_mail_a
            .open_bytes(&stored_a.smtp_password, aad_a)
            .unwrap(),
        b"smtp-secret-pass"
    );

    // Scope 4b: trg_employee_rrn_org_immutable raises P0001 (not 42703).
    let imm_err = sqlx::query("UPDATE employee_rrn SET org_id = $1 WHERE employee_id = $2") // rls-arming: ok owner verifies immutability trigger
        .bind(b.org_uuid)
        .bind(emp_a)
        .execute(&owner)
        .await
        .unwrap_err();
    assert_eq!(
        imm_err.as_database_error().unwrap().code().as_deref(),
        Some("P0001")
    );

    // Seed legacy v1/v2/direct-v3 ciphertexts + all 9 S3 tables (incl. EV WORM/append-only) and execute two-operator erasure.
    let unscoped_rrn = console_app::EnvRrnVault::from_owned_values(
        Some(ring.clone()),
        None,
        None,
        Some(h_b64.clone()),
    )
    .unwrap()
    .unwrap();
    let legacy_a =
        seal_pre_shred_legacy_envelopes(&unscoped_rrn, &mail_base, a.org_uuid, *acc_a.as_uuid());
    let expected_s3 = seed_all_nine_s3_tables(
        &owner,
        a.org_uuid,
        *a.actor.as_uuid(),
        emp_a,
        *acc_a.as_uuid(),
    )
    .await;
    sqlx::query("UPDATE organizations SET status = 'ARCHIVED' WHERE id = $1") // rls-arming: ok owner archives target
        .bind(a.org_uuid)
        .execute(&owner)
        .await
        .unwrap();
    let approver =
        seed_org_and_super_admin(&owner, *OrgId::platform().as_uuid(), "Erase Approver").await;
    governed_erase::due(&owner, a.org_uuid, *approver.as_uuid()).await;

    let force = force_role_pool(&owner).await;
    assert_eq!(
        PlatformProvisioner::run_due_tenant_erases(&force)
            .await
            .unwrap(),
        1
    );

    let sink = LogSink::default();
    let sub = tracing_subscriber::fmt().with_writer(sink.clone()).finish();
    let _guard = tracing::subscriber::set_default(sub);
    let emitted = PlatformProvisioner::emit_pending_erase_witnesses(&a.rt)
        .await
        .unwrap();
    assert_eq!(emitted, 1);
    let logs = String::from_utf8_lossy(&sink.0.lock().unwrap()).into_owned();
    assert!(
        logs.contains("console.erasure_ledger.witness") && logs.contains(&a.org_uuid.to_string())
    );
    assert!(!logs.contains("900101") && !logs.contains("smtp-secret-pass"));

    // Verify SHREDDED tombstones survive org deletion, triggers block restore, console_rt cannot insert SHREDDED, and erasure_ledger witnesses align.
    assert_shredded_triggers_and_witness(&owner, &a.rt, a.org).await;
    assert_console_rt_cannot_insert_shredded(&b.rt, b.org).await;
    let shredded = ShreddedTenant {
        rt: &a.rt,
        org: a.org,
        mail_base: &mail_base,
        rrn: &sealed_a,
        smtp_password: &stored_a.smtp_password,
        mail_account: *acc_a.as_uuid(),
    };
    assert_shredded_fail_closed_all_versions(&owner, &shredded, &store, &vault_a, &legacy_a).await;

    // PITR simulation: fresh cold cache/store + pre-erasure ciphertexts MUST fail closed.
    assert_cold_pitr_fails_closed(&shredded, &ring, &h_b64, &staged_a, &stored_a.imap_password)
        .await;

    // Control Org B still decrypts RRN, staged RRN, and mail credentials.
    let hr_b = HrService::new(b.rt.clone()).with_rrn_vault(Some(vault_b.clone()));
    assert_eq!(
        reveal_with_step_up(
            &owner,
            &hr_b,
            b.org,
            b.actor,
            b.principal.clone(),
            emp_b,
            vault_b.as_ref()
        )
        .await,
        "880202-2345678"
    );
    assert_eq!(
        vault_b
            .scoped_for_org(b.org_uuid)
            .await
            .unwrap()
            .unwrap()
            .open(b.org_uuid, &staged_b)
            .unwrap(),
        rrn_b
    );
    let stored_b = CURRENT_ORG
        .scope(b.org, PgMailStore::new(b.rt.clone()).get_account())
        .await
        .unwrap()
        .unwrap();
    let aad_b = Aad {
        org_id: &b.org.to_string(),
        account_id: &acc_b.to_string(),
        field: "smtp_password",
    };
    assert!(
        mail_b_scoped
            .decrypt(&stored_b.smtp_password, aad_b)
            .is_ok()
    );
    assert_eq!(
        env_mail_b
            .open_bytes(&stored_b.smtp_password, aad_b)
            .unwrap(),
        b"smtp-secret-pass"
    );

    // S3 outbox purge across all 9 tables: 200 + 404 NoSuchKey + EXPLICIT delete, WORM 403 replica defers 24h.
    assert_all_nine_s3_outbox_drain(&owner, &a.rt, a.org_uuid, &expected_s3).await;
}
