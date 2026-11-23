// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[path = "support/credential_reseal_helpers.rs"]
mod helpers;
#[path = "support/rrn_blind_index.rs"]
mod rrn_support;
#[path = "support/tenant_crypto_shred.rs"]
mod shred_support;

use std::process::Command;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use console_app::crypto_reseal::execute_census;
use console_app::mail_cipher::TenantEnvMailCipher;
use console_comms_credential_cipher::EnvelopeCredentialCipher;
use console_hr_domain::import::rrn_value::{Rrn, RrnVault};
use console_platform_crypto::{
    KekId, LocalKeyringProvider, TenantDekMode, TenantKeyScope, tenant_key_fingerprint,
};
use console_platform_db::tenant_keys::PgTenantKeyStore;
use helpers::keyring_json;
use rrn_support::{TestEnvVault, seed_tenant};
use serde_json::Value;
use shred_support::build_env_vault;
use sqlx::{PgPool, Row};

fn runtime_db_url(owner: &PgPool) -> String {
    let opts = owner.connect_options();
    let pw = std::env::var("CONSOLE_TEST_RUNTIME_PASSWORD").unwrap_or_else(|_| "test".to_owned());
    let host = opts.get_host();
    let port = opts.get_port();
    let db = opts.get_database().unwrap_or("postgres");
    format!("postgres://console_rt:{pw}@{host}:{port}/{db}")
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn dual_read_mode_rotation_rewrap_and_read_only_census(owner: PgPool) {
    let k1_ring = keyring_json("k1", &[("k1", 0x41)]);
    let k1_k2_ring = keyring_json("k2", &[("k1", 0x41), ("k2", 0x42)]);
    let k2_only_ring = keyring_json("k2", &[("k2", 0x42)]);
    let h_b64 = BASE64.encode([0x43u8; 32]);
    let dummy_v = TestEnvVault::from_keyrings(Some(&k1_ring), None, None, Some(&h_b64));
    let a = seed_tenant(&owner, "rot-a", dummy_v).await;

    // 1. DualRead writes direct-KEK v3 without inserting into tenant_encryption_keys.
    let dual_store = Arc::new(PgTenantKeyStore::new(TenantDekMode::DualRead));
    let dual_vault = build_env_vault(a.rt.clone(), &k1_ring, &h_b64, dual_store);
    let rrn = Rrn::parse("900101-1234567").unwrap();
    let direct_sealed = dual_vault
        .scoped_for_org(a.org_uuid)
        .await
        .unwrap()
        .unwrap()
        .seal(a.org_uuid, &rrn)
        .unwrap();
    assert_eq!(direct_sealed.kek_id.as_deref(), Some("k1"));
    let key_count: i64 = sqlx::query_scalar(
        // rls-arming: ok owner verifies zero DEKs
        "SELECT count(*) FROM tenant_encryption_keys WHERE org_id = $1",
    )
    .bind(a.org_uuid)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(key_count, 0);

    // 2. Read-only census must insert ZERO tenant_encryption_keys and ZERO provision audit events.
    let active_store = Arc::new(PgTenantKeyStore::new(TenantDekMode::Active));
    let active_vault = build_env_vault(a.rt.clone(), &k1_ring, &h_b64, active_store.clone());
    let mail_base = Arc::new(
        EnvelopeCredentialCipher::from_owned_env_values(Some(k1_ring.clone()), None)
            .unwrap()
            .unwrap(),
    );
    let mail_cipher = TenantEnvMailCipher::new(mail_base.clone(), a.rt.clone());
    let report = execute_census(&a.rt, Some(active_vault.as_ref()), Some(&mail_cipher))
        .await
        .unwrap();
    assert_eq!(report.tenant_dek_mode, "active");
    let rrn_rep = report.rrn.unwrap();
    assert_eq!(rrn_rep.master_active_kek_id.as_deref(), Some("k1"));
    assert_eq!(rrn_rep.target_kek_pattern, "tdek:<org>:rrn:v<ver>");
    let post_census_keys: i64 = sqlx::query_scalar(
        // rls-arming: ok owner verifies read-only census
        "SELECT count(*) FROM tenant_encryption_keys WHERE org_id = $1",
    )
    .bind(a.org_uuid)
    .fetch_one(&owner)
    .await
    .unwrap();
    let provision_audits: i64 = sqlx::query_scalar( // rls-arming: ok owner verifies read-only census
        "SELECT count(*) FROM audit_events WHERE org_id = $1 AND action = 'platform.tenant_key.provision'",
    )
    .bind(a.org_uuid)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!((post_census_keys, provision_audits), (0, 0));

    // 3. Provision v1 in Active mode -> seal v1 -> DualRead still opens tdek:...:v1 -> rotate v1->v2.
    let tdek_v1 = active_vault
        .scoped_for_org(a.org_uuid)
        .await
        .unwrap()
        .unwrap()
        .seal(a.org_uuid, &rrn)
        .unwrap();
    assert_eq!(
        tdek_v1.kek_id.as_deref(),
        Some(format!("tdek:{}:rrn:v1", a.org_uuid).as_str())
    );
    assert_eq!(
        dual_vault
            .scoped_for_org(a.org_uuid)
            .await
            .unwrap()
            .unwrap()
            .open(a.org_uuid, &tdek_v1)
            .unwrap(),
        rrn
    );

    let k1_kms: Arc<dyn console_platform_crypto::KmsProvider> = Arc::new(
        LocalKeyringProvider::from_env_values(Some(k1_ring.clone().into()), None)
            .unwrap()
            .unwrap(),
    );
    let k1_k2_kms: Arc<dyn console_platform_crypto::KmsProvider> = Arc::new(
        LocalKeyringProvider::from_env_values(Some(k1_k2_ring.clone().into()), None)
            .unwrap()
            .unwrap(),
    );
    let new_ver = active_store
        .rotate_tenant_dek(&a.rt, a.org, TenantKeyScope::Rrn, k1_kms, None)
        .await
        .unwrap();
    assert_eq!(new_ver, 2);
    let tdek_v2 = active_vault
        .scoped_for_org(a.org_uuid)
        .await
        .unwrap()
        .unwrap()
        .seal(a.org_uuid, &rrn)
        .unwrap();
    assert_eq!(
        tdek_v2.kek_id.as_deref(),
        Some(format!("tdek:{}:rrn:v2", a.org_uuid).as_str())
    );

    // 4. Rewrap master KEK k1 -> k2, verify updated key_fingerprint, and prove k2-only store opens v1 & v2.
    let rewrapped = active_store
        .rewrap_master_kek_scope_batch(&a.rt, a.org, TenantKeyScope::Rrn, k1_k2_kms, 10)
        .await
        .unwrap();
    assert_eq!(rewrapped, 2);
    let rows = sqlx::query( // rls-arming: ok owner verifies key_fingerprint after rewrap
        "SELECT key_version, kek_id, wrapped_dek, key_fingerprint \
           FROM tenant_encryption_keys WHERE org_id = $1 AND key_scope = 'rrn' ORDER BY key_version",
    )
    .bind(a.org_uuid)
    .fetch_all(&owner)
    .await
    .unwrap();
    assert_eq!(rows.len(), 2);
    for row in rows {
        let ver: i32 = row.get("key_version");
        let kek_id: String = row.get("kek_id");
        let wrapped: Vec<u8> = row.get("wrapped_dek");
        let fp: Vec<u8> = row.get("key_fingerprint");
        assert_eq!(kek_id, "k2");
        let expected_fp = tenant_key_fingerprint(
            a.org_uuid,
            TenantKeyScope::Rrn,
            ver,
            &KekId::new("k2").unwrap(),
            &wrapped,
        );
        assert_eq!(fp, expected_fp.as_slice());
    }

    let cold_k2_store = Arc::new(PgTenantKeyStore::new(TenantDekMode::Active));
    let cold_k2_vault = build_env_vault(a.rt.clone(), &k2_only_ring, &h_b64, cold_k2_store);
    let scoped_k2 = cold_k2_vault
        .scoped_for_org(a.org_uuid)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(scoped_k2.open(a.org_uuid, &tdek_v1).unwrap(), rrn);
    assert_eq!(scoped_k2.open(a.org_uuid, &tdek_v2).unwrap(), rrn);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn live_cli_crypto_census_rotate_and_rewrap_against_pg(owner: PgPool) {
    let rrn_k1 = keyring_json("k1", &[("k1", 0x51)]);
    let rrn_k2 = keyring_json("k2", &[("k1", 0x51), ("k2", 0x52)]);
    let mail_k1 = keyring_json("m1", &[("m1", 0x61)]);
    let mail_k2 = keyring_json("m2", &[("m1", 0x61), ("m2", 0x62)]);
    let h_b64 = BASE64.encode([0x53u8; 32]);
    let dummy_v = TestEnvVault::from_keyrings(Some(&rrn_k1), None, None, Some(&h_b64));
    let a = seed_tenant(&owner, "cli-a", dummy_v).await;
    let db_url = runtime_db_url(&owner);
    let bin = env!("CARGO_BIN_EXE_console-app");

    // 1. CLI crypto-census must be strictly read-only.
    let census_out = Command::new(bin)
        .arg("crypto-census")
        .env("DATABASE_URL", &db_url)
        .env("CONSOLE_RRN_KEYRING", &rrn_k1)
        .env("CONSOLE_RRN_HMAC_KEY", &h_b64)
        .env("CONSOLE_MAIL_KEYRING", &mail_k1)
        .output()
        .unwrap();
    assert!(
        census_out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&census_out.stderr)
    );
    let census_json: Value = serde_json::from_slice(&census_out.stdout).unwrap();
    assert_eq!(census_json["tenant_dek_mode"], "active");
    let keys_after_census: i64 = sqlx::query_scalar(
        // rls-arming: ok owner verifies zero writes
        "SELECT count(*) FROM tenant_encryption_keys WHERE org_id = $1",
    )
    .bind(a.org_uuid)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(keys_after_census, 0);

    // 2. CLI rotate-tenant-dek for all scopes, then rrn-only.
    let org_s = a.org_uuid.to_string();
    let rot1 = Command::new(bin)
        .args(["rotate-tenant-dek", "--org", &org_s, "--scope", "all"])
        .env("DATABASE_URL", &db_url)
        .env("CONSOLE_RRN_KEYRING", &rrn_k1)
        .env("CONSOLE_MAIL_KEYRING", &mail_k1)
        .output()
        .unwrap();
    assert!(
        rot1.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&rot1.stderr)
    );
    let rot1_json: Value = serde_json::from_slice(&rot1.stdout).unwrap();
    assert_eq!(rot1_json["rrn_version"], 1);
    assert_eq!(rot1_json["mail_version"], 1);

    let rot2 = Command::new(bin)
        .args(["rotate-tenant-dek", "--org", &org_s, "--scope=rrn"])
        .env("DATABASE_URL", &db_url)
        .env("CONSOLE_RRN_KEYRING", &rrn_k1)
        .output()
        .unwrap();
    assert!(
        rot2.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&rot2.stderr)
    );
    let rot2_json: Value = serde_json::from_slice(&rot2.stdout).unwrap();
    assert_eq!(rot2_json["rrn_version"], 2);
    assert!(rot2_json["mail_version"].is_null());

    // 3. CLI rewrap-master-kek across distinct RRN and Mail master keyrings.
    let rewrap = Command::new(bin)
        .args([
            "rewrap-master-kek",
            "--org",
            &org_s,
            "--batch-size=10",
            "--max-batches",
            "5",
        ])
        .env("DATABASE_URL", &db_url)
        .env("CONSOLE_RRN_KEYRING", &rrn_k2)
        .env("CONSOLE_MAIL_KEYRING", &mail_k2)
        .output()
        .unwrap();
    assert!(
        rewrap.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&rewrap.stderr)
    );
    let rewrap_json: Value = serde_json::from_slice(&rewrap.stdout).unwrap();
    assert_eq!(rewrap_json["orgs_scanned"], 1);
    assert_eq!(rewrap_json["rrn_keys_rewrapped"], 2);
    assert_eq!(rewrap_json["mail_keys_rewrapped"], 1);
}
