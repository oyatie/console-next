// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[path = "support/credential_reseal_helpers.rs"]
mod helpers;
#[path = "support/rrn_blind_index.rs"]
mod rrn_support;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use console_app::crypto_reseal::{execute_census, execute_reseal};
use console_comms_adapter_postgres::PgMailStore;
use console_comms_credential_cipher::EnvelopeCredentialCipher;
use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::import::{identities, sheet::StagedIdentity};
use console_hr_domain::import::rrn_value::{Rrn, RrnVault, SealedRrn, VaultError};
use console_platform_db::with_org_conn;
use helpers::{
    LogSink, assert_mail_decrypts_and_cross_tenant_fails, assert_reseal_audits_and_zero_leakage,
    keyring_json, reveal_with_step_up, seal_rrn_with_suite, seed_mail_account, seed_rrn_row,
};
use rrn_support::{TestEnvVault, seed_employee, seed_import_run, seed_tenant};
use sqlx::{PgPool, Row};
use std::collections::BTreeMap;
use std::sync::Arc;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn batched_reseal_rotation_census_audit_isolation_and_n_minus_1_rollback(pool: PgPool) {
    let k1_ring = keyring_json("k1", &[("k1", 0x51)]);
    let k2_ring = keyring_json("k2", &[("k1", 0x51), ("k2", 0x52)]);
    let h_b64 = BASE64.encode([0x61u8; 32]);
    let vault_k1 = TestEnvVault::from_keyrings(Some(&k1_ring), None, None, Some(&h_b64));
    let vault_k2 = TestEnvVault::from_keyrings(Some(&k2_ring), None, None, Some(&h_b64));
    let mail_k1 = EnvelopeCredentialCipher::from_owned_env_values(Some(k1_ring), None)
        .unwrap()
        .unwrap();
    let mail_k2 = Arc::new(
        EnvelopeCredentialCipher::from_owned_env_values(Some(k2_ring), None)
            .unwrap()
            .unwrap(),
    );

    let a = seed_tenant(&pool, "rs-a", vault_k2.clone()).await;
    let b = seed_tenant(&pool, "rs-b", vault_k2.clone()).await;
    let mail_a = PgMailStore::new(a.rt.clone());
    let mail_b = PgMailStore::new(b.rt.clone());

    let acc_a1 = seed_mail_account(&pool, a.org, a.actor, "a1@ex.test", &mail_k1, 1, 2).await;
    let acc_a2 = seed_mail_account(&pool, a.org, a.actor, "a2@ex.test", &mail_k1, 3, 1).await;
    let acc_b1 = seed_mail_account(&pool, b.org, b.actor, "b1@ex.test", &mail_k2, 3, 2).await;

    let mut emp_a = Vec::new();
    for (idx, (raw, suite, use_k2)) in [
        ("900101-1234567", 1i16, false),
        ("850505-2234567", 2, false),
        ("920304-1000000", 3, false),
        ("880808-2000000", 3, true),
    ]
    .iter()
    .enumerate()
    {
        let emp = seed_employee(&pool, a.org_uuid, &format!("RA-{idx}"), "Alpha").await;
        let v = if *use_k2 { &vault_k2 } else { &vault_k1 };
        let sealed = seal_rrn_with_suite(v, a.org_uuid, raw, *suite);
        seed_rrn_row(&pool, a.org_uuid, emp, *a.actor.as_uuid(), &sealed).await;
        emp_a.push(emp);
    }

    let run_a = seed_import_run(&pool, a.org_uuid).await;
    let s_v1 = seal_rrn_with_suite(&vault_k1, a.org_uuid, "910202-1234567", 1);
    let s_k1 = vault_k1
        .seal(a.org_uuid, &Rrn::parse("930303-2234567").unwrap())
        .unwrap();
    with_org_conn(&a.rt, a.org, move |tx| {
        Box::pin(async move {
            identities::stage(
                tx,
                a.org_uuid,
                run_a,
                &[
                    StagedIdentity {
                        source_key: "st-1".into(),
                        sealed: s_v1,
                    },
                    StagedIdentity {
                        source_key: "st-2".into(),
                        sealed: s_k1,
                    },
                ],
            )
            .await
        })
    })
    .await
    .unwrap();

    let pre = execute_census(&a.rt, Some(vault_k2.as_ref()), Some(mail_k2.as_ref()))
        .await
        .unwrap();
    let pre_rrn = pre.rrn.as_ref().unwrap();
    assert_eq!(
        (
            pre_rrn.employee_rrn.v1,
            pre_rrn.employee_rrn.v2,
            pre_rrn.employee_rrn.v3_stale_kek,
            pre_rrn.employee_rrn.v3_current
        ),
        (1, 1, 1, 1)
    );
    assert_eq!(
        (
            pre_rrn.data_import_row_identities.v1,
            pre_rrn.data_import_row_identities.v3_stale_kek
        ),
        (1, 1)
    );
    let pre_mail = pre.email.as_ref().unwrap();
    assert_eq!(
        (
            pre_mail.smtp.v1,
            pre_mail.smtp.v3_stale_kek,
            pre_mail.smtp.v3_current
        ),
        (1, 1, 1)
    );
    assert_eq!((pre_mail.imap.v1, pre_mail.imap.v2), (1, 2));

    assert_eq!(
        a.hr.reseal_employee_rrn_batch(a.org, vault_k2.clone(), 2)
            .await
            .unwrap(),
        2
    );

    let sink = LogSink::default();
    let _guard = tracing::subscriber::set_default(
        tracing_subscriber::fmt().with_writer(sink.clone()).finish(),
    );
    let done = execute_reseal(&a.rt, Some(vault_k2.clone()), Some(mail_k2.clone()), 10, 20)
        .await
        .unwrap();
    assert_eq!(
        (
            done.rrn.employee_rrn_updated,
            done.rrn.staged_identities_updated
        ),
        (1, 2)
    );
    let done_mail = done.email.as_ref().unwrap();
    assert_eq!(
        (
            done_mail.accounts_updated,
            done_mail.smtp_resealed,
            done_mail.imap_resealed
        ),
        (3, 2, 3)
    );

    let post = execute_census(&a.rt, Some(vault_k2.as_ref()), Some(mail_k2.as_ref()))
        .await
        .unwrap();
    let emp_c = &post.rrn.as_ref().unwrap().employee_rrn;
    let stg_c = &post.rrn.as_ref().unwrap().data_import_row_identities;
    assert_eq!(
        (emp_c.v1, emp_c.v2, emp_c.v3_stale_kek, emp_c.v3_current),
        (0, 0, 0, 4)
    );
    assert_eq!(
        (stg_c.v1, stg_c.v2, stg_c.v3_stale_kek, stg_c.v3_current),
        (0, 0, 0, 2)
    );
    let mail_c = post.email.as_ref().unwrap();
    assert_eq!(
        (
            mail_c.smtp.v1,
            mail_c.smtp.v2,
            mail_c.smtp.v3_stale_kek,
            mail_c.smtp.v3_current
        ),
        (0, 0, 0, 3)
    );
    assert_eq!(
        (
            mail_c.imap.v1,
            mail_c.imap.v2,
            mail_c.imap.v3_stale_kek,
            mail_c.imap.v3_current
        ),
        (0, 0, 0, 3)
    );

    let rerun = execute_reseal(&a.rt, Some(vault_k2.clone()), Some(mail_k2.clone()), 10, 20)
        .await
        .unwrap();
    assert_eq!(
        (
            rerun.rrn.employee_rrn_updated,
            rerun.rrn.staged_identities_updated,
            rerun.email.unwrap().accounts_updated
        ),
        (0, 0, 0)
    );

    let emp_promoted = seed_employee(&pool, a.org_uuid, "RA-P", "Promoted").await;
    with_org_conn(&a.rt, a.org, move |tx| {
        Box::pin(async move {
            identities::record(
                tx,
                a.org_uuid,
                *a.actor.as_uuid(),
                run_a,
                &BTreeMap::from([("st-1".into(), emp_promoted)]),
                None,
            )
            .await
        })
    })
    .await
    .unwrap();
    assert_eq!(
        reveal_with_step_up(
            &pool,
            &a.hr,
            a.org,
            a.actor,
            a.principal.clone(),
            emp_promoted,
            vault_k2.as_ref()
        )
        .await,
        "910202-1234567"
    );

    for (store, org, aid) in [
        (&mail_a, a.org, acc_a1),
        (&mail_a, a.org, acc_a2),
        (&mail_b, b.org, acc_b1),
    ] {
        assert_mail_decrypts_and_cross_tenant_fails(store, org, aid, &mail_k2).await;
    }
    assert_reseal_audits_and_zero_leakage(&pool, &sink).await;

    let row_a = sqlx::query("SELECT * FROM employee_rrn WHERE org_id = $1 AND employee_id = $2")
        .bind(a.org_uuid)
        .bind(emp_a[0])
        .fetch_one(&pool)
        .await
        .unwrap();
    let transplanted = SealedRrn {
        hmac: row_a.get("rrn_hmac"),
        hmac_key_version: row_a.get("hmac_key_version"),
        hmac_v2: row_a.get("rrn_hmac_v2"),
        blind_index_version: row_a.get("blind_index_version"),
        ciphertext: row_a.get("ciphertext"),
        nonce: row_a.get("nonce"),
        dek_wrapped: row_a.get("dek_wrapped"),
        dek_nonce: row_a.get("dek_nonce"),
        key_version: row_a.get("key_version"),
        masked: row_a.get("masked"),
        alg_id: row_a.get("alg_id"),
        kek_id: row_a.get("kek_id"),
        msg_id: row_a.get("msg_id"),
        commitment_tag: row_a.get("commitment_tag"),
    };
    assert_eq!(vault_k2.open(b.org_uuid, &transplanted), Err(VaultError));
    assert!(
        with_org_conn(&a.rt, a.org, move |tx| {
            Box::pin(async move {
                sqlx::query("UPDATE data_import_row_identities SET org_id = $1 WHERE org_id = $2")
                    .bind(b.org_uuid)
                    .bind(a.org_uuid)
                    .execute(tx.as_mut())
                    .await
                    .map_err(console_hr_adapter_postgres::HrError::from)
            })
        })
        .await
        .is_err()
    );

    let emp_rb = seed_employee(&pool, b.org_uuid, "RB-1", "Rollback").await;
    let s_rb = seal_rrn_with_suite(&vault_k1, b.org_uuid, "870707-1234567", 1);
    seed_rrn_row(&pool, b.org_uuid, emp_rb, *b.actor.as_uuid(), &s_rb).await;
    assert_eq!(
        HrService::new(b.rt.clone())
            .reseal_rrn_envelopes(vault_k2)
            .await
            .unwrap()
            .employee_rrn_updated,
        1
    );
}
