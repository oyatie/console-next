// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, dead_code)]

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use console_app::EnvRrnVault;
use console_hr_domain::import::rrn_value::SealedRrn;
use console_kernel_core::OrgId;
use console_platform_db::tenant_keys::PgTenantKeyStore;
use console_platform_db::with_org_conn;
use console_platform_provisioning::PlatformProvisioner;
use console_platform_storage::{
    CopyObjectRequest, ObjectHead, PresignGetRequest, PresignPutRequest, PresignedUpload,
    RetentionInfo, S3ObjectStore, StorageError, StorageFuture,
};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

#[derive(Default)]
pub struct FakeS3Store {
    pub deletes: Mutex<Vec<(String, String)>>,
    pub worm_replica_locked: bool,
    pub not_found_keys: HashSet<String>,
}

impl S3ObjectStore for FakeS3Store {
    fn presign_put(&self, _: PresignPutRequest) -> StorageFuture<'_, PresignedUpload> {
        unreachable!()
    }
    fn presign_get(&self, _: PresignGetRequest) -> StorageFuture<'_, String> {
        unreachable!()
    }
    fn copy_object(&self, _: CopyObjectRequest) -> StorageFuture<'_, ()> {
        unreachable!()
    }
    fn head_object(&self, _: String, _: String) -> StorageFuture<'_, ObjectHead> {
        unreachable!()
    }
    fn get_object_retention(&self, _: String, _: String) -> StorageFuture<'_, RetentionInfo> {
        unreachable!()
    }
    fn get_object(&self, _: String, _: String) -> StorageFuture<'_, Vec<u8>> {
        unreachable!()
    }
    fn put_object(&self, _: String, _: String, _: String, _: Vec<u8>) -> StorageFuture<'_, ()> {
        unreachable!()
    }
    fn delete_object(&self, bucket: String, key: String) -> StorageFuture<'_, ()> {
        Box::pin(async move {
            if self.worm_replica_locked && bucket == "replica-bkt" {
                return Err(StorageError::S3(
                    "delete object failed with 403 Forbidden: AccessDenied".into(),
                ));
            }
            if self.not_found_keys.contains(&key) {
                return Err(StorageError::S3(
                    "delete object failed with 404 Not Found: NoSuchKey".into(),
                ));
            }
            self.deletes.lock().unwrap().push((bucket, key));
            Ok(())
        })
    }
}

pub async fn force_role_pool(owner: &PgPool) -> PgPool {
    if let Ok(pw) = std::env::var("CONSOLE_TEST_FORCE_PASSWORD") {
        let opts = owner
            .connect_options()
            .as_ref()
            .clone()
            .username("console_platform_force_cmd")
            .password(&pw);
        return PgPoolOptions::new()
            .max_connections(2)
            .connect_with(opts)
            .await
            .unwrap();
    }
    PgPoolOptions::new()
        .max_connections(2)
        .after_connect(|conn, _| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_platform_force_cmd")
                    .execute(conn)
                    .await?;
                Ok(())
            })
        })
        .connect_with(owner.connect_options().as_ref().clone())
        .await
        .unwrap()
}

pub fn build_env_vault(
    rt: PgPool,
    ring_json: &str,
    h_b64: &str,
    store: Arc<PgTenantKeyStore>,
) -> Arc<EnvRrnVault> {
    let vault = EnvRrnVault::from_owned_values(
        Some(ring_json.to_owned()),
        None,
        None,
        Some(h_b64.to_owned()),
    )
    .unwrap()
    .unwrap()
    .with_tenant_keys(rt, store);
    Arc::new(vault)
}

pub async fn seed_staged_rrn(owner: &PgPool, org: Uuid, run: Uuid, src: &str, st: &SealedRrn) {
    sqlx::query(
        "INSERT INTO data_import_row_identities \
         (org_id, run_id, source_key, rrn_hmac, hmac_key_version, rrn_hmac_v2, \
          blind_index_version, ciphertext, nonce, dek_wrapped, dek_nonce, key_version, \
          masked, alg_id, kek_id, msg_id, commitment_tag) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)", // rls-arming: ok owner fixture seeds staged RRN
    )
    .bind(org)
    .bind(run)
    .bind(src)
    .bind(&st.hmac)
    .bind(st.hmac_key_version)
    .bind(st.hmac_v2.as_deref())
    .bind(st.blind_index_version)
    .bind(&st.ciphertext)
    .bind(&st.nonce)
    .bind(&st.dek_wrapped)
    .bind(&st.dek_nonce)
    .bind(st.key_version)
    .bind(&st.masked)
    .bind(st.alg_id.as_deref())
    .bind(st.kek_id.as_deref())
    .bind(st.msg_id.as_deref())
    .bind(st.commitment_tag.as_deref())
    .execute(owner)
    .await
    .unwrap();
}

pub async fn assert_shredded_triggers_and_witness(owner: &PgPool, rt: &PgPool, org: OrgId) {
    let org_uuid = *org.as_uuid();
    let tombstones: i64 = sqlx::query_scalar(
        // rls-arming: ok owner verifies shredded tombstones
        "SELECT count(*) FROM tenant_encryption_keys WHERE org_id = $1 AND state = 'SHREDDED' \
         AND wrapped_dek IS NULL AND shredded_at IS NOT NULL AND shredded_request_id IS NOT NULL",
    )
    .bind(org_uuid)
    .fetch_one(owner)
    .await
    .unwrap();
    assert_eq!(tombstones, 2);
    let del_err = sqlx::query("DELETE FROM tenant_encryption_keys WHERE org_id = $1") // rls-arming: ok trigger proof
        .bind(org_uuid)
        .execute(owner)
        .await
        .unwrap_err();
    assert_eq!(
        del_err.as_database_error().unwrap().code().as_deref(),
        Some("P0001")
    );
    let upd_err = sqlx::query( // rls-arming: ok trigger proof
        "UPDATE tenant_encryption_keys SET state = 'ACTIVE', wrapped_dek = decode('00', 'hex') WHERE org_id = $1",
    )
    .bind(org_uuid)
    .execute(owner)
    .await
    .unwrap_err();
    assert_eq!(
        upd_err.as_database_error().unwrap().code().as_deref(),
        Some("55000")
    );

    let (witness_seq, witness_hash, chain_ok): (i64, Vec<u8>, bool) =
        with_org_conn(rt, org, |tx| {
            Box::pin(async move {
                sqlx::query_as(
                    "SELECT seq, entry_hash, \
                            entry_hash = erasure_ledger_entry_hash(org_id, seq, prev_entry_hash, subject_kind, subject_digest, erased_relation, erased_selector, erased_row_count, actor, authority, effective_at) \
                       FROM erasure_ledger WHERE org_id = $1 AND subject_kind = 'tenant_dek'",
                )
                .bind(org_uuid)
                .fetch_one(tx.as_mut())
                .await
                .map_err(console_platform_db::DbError::from)
            })
        })
        .await
        .unwrap();
    assert!(chain_ok);
    let (req_seq, req_hash, req_fp): (i64, Vec<u8>, Vec<u8>) = sqlx::query_as(
        // rls-arming: ok owner verifies witness columns
        "SELECT erasure_witness_seq, erasure_witness_hash, shredded_key_fingerprint \
           FROM tenant_erase_requests WHERE target_org_id = $1",
    )
    .bind(org_uuid)
    .fetch_one(owner)
    .await
    .unwrap();
    assert_eq!(
        (req_seq, req_hash.as_slice()),
        (witness_seq, witness_hash.as_slice())
    );
    assert_eq!(req_fp.len(), 32);
}

/// Prove `console_rt` cannot bypass `tenant_encryption_keys_shred_guard()` via
/// `set_config('app.platform_force_remove_org', 'on', true)` + `INSERT SHREDDED`.
pub async fn assert_console_rt_cannot_insert_shredded(rt: &PgPool, survivor_org: OrgId) {
    let org_uuid = *survivor_org.as_uuid();
    let res = with_org_conn(rt, survivor_org, move |tx| {
        Box::pin(async move {
            sqlx::query("SELECT set_config('app.platform_force_remove_org', 'on', true)")
                .execute(tx.as_mut())
                .await
                .map_err(console_platform_db::DbError::from)?;
            sqlx::query(
                "INSERT INTO tenant_encryption_keys \
                 (org_id, key_scope, key_version, state, alg_id, kek_id, wrapped_dek, key_fingerprint) \
                 VALUES ($1, 'mail', 99, 'SHREDDED', 'shredded', 'shredded', NULL, decode(repeat('88', 32), 'hex'))",
            )
            .bind(org_uuid)
            .execute(tx.as_mut())
            .await
            .map_err(console_platform_db::DbError::from)
        })
    })
    .await;
    let err = res.unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("42501")
            || msg.contains("tenant key shredding requires platform force removal command"),
        "expected 42501 shred guard rejection, got {msg}"
    );
}

pub async fn assert_all_nine_s3_outbox_drain(
    owner: &PgPool,
    rt: &PgPool,
    org_uuid: Uuid,
    expected_keys: &[(String, Option<String>, String)],
) {
    let rows: Vec<(String, Option<String>, String)> = sqlx::query_as( // rls-arming: ok owner verifies outbox rows
        "SELECT bucket_kind, explicit_bucket, object_key FROM tenant_erase_s3_outbox WHERE target_org_id = $1",
    )
    .bind(org_uuid)
    .fetch_all(owner)
    .await
    .unwrap();
    for expected in expected_keys {
        assert!(rows.contains(expected), "missing outbox row: {expected:?}");
    }
    let not_found = expected_keys
        .iter()
        .find(|(kind, _, _)| kind == "EXPLICIT")
        .map(|(_, _, k)| k.clone())
        .into_iter()
        .collect();
    let fake_s3 = FakeS3Store {
        worm_replica_locked: true,
        not_found_keys: not_found,
        ..Default::default()
    };
    let stats = PlatformProvisioner::drain_erased_tenant_objects(
        rt,
        &fake_s3,
        "primary-bkt",
        Some("replica-bkt"),
    )
    .await
    .unwrap();
    let expected_primary_plus_explicit = expected_keys
        .iter()
        .filter(|(k, _, _)| k != "REPLICA")
        .count();
    let expected_replica = expected_keys
        .iter()
        .filter(|(k, _, _)| k == "REPLICA")
        .count();
    assert_eq!(
        (stats.deleted, stats.deferred_worm, stats.retried),
        (expected_primary_plus_explicit, expected_replica, 0)
    );
    let deletes = fake_s3.deletes.lock().unwrap();
    for (kind, _, key) in expected_keys {
        if kind == "PRIMARY" {
            assert!(deletes.contains(&("primary-bkt".to_owned(), key.clone())));
        }
    }
    let remaining: i64 = sqlx::query_scalar(
        // rls-arming: ok owner verifies outbox drain
        "SELECT count(*) FROM tenant_erase_s3_outbox WHERE target_org_id = $1",
    )
    .bind(org_uuid)
    .fetch_one(owner)
    .await
    .unwrap();
    assert_eq!(remaining, i64::try_from(expected_replica).unwrap());
}
