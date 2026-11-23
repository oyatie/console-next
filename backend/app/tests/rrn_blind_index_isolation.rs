// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[path = "support/rrn_blind_index.rs"]
mod rrn_support;

use console_hr_adapter_postgres::import::{identities, plan_facts, sheet::StagedIdentity};
use console_hr_domain::import::plan::ImportRow;
use console_hr_domain::import::rrn_value::{Rrn, RrnVault, VaultError};
use console_platform_db::with_org_conn;
use rrn_support::{TestEnvVault, seed_employee, seed_import_run, seed_tenant};
use sqlx::{PgPool, Row};
use std::collections::BTreeMap;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn t2_cross_tenant_blind_index_isolation_and_transplant_fail_closed(pool: PgPool) {
    let vault = TestEnvVault::new(0x11, 0x22);
    let a = seed_tenant(&pool, "iso-a", vault.clone()).await;
    let b = seed_tenant(&pool, "iso-b", vault.clone()).await;

    let emp_a = seed_employee(&pool, a.org_uuid, "A-01", "Alice").await;
    let emp_b = seed_employee(&pool, b.org_uuid, "B-01", "Bob").await;
    let emp_b2 = seed_employee(&pool, b.org_uuid, "B-02", "BobTwo").await;

    let rrn = Rrn::parse("900101-1234567").unwrap();
    let sealed_a = vault.seal(a.org_uuid, &rrn).unwrap();
    let sealed_b = vault.seal(b.org_uuid, &rrn).unwrap();
    assert_ne!(sealed_a.hmac_v2, sealed_b.hmac_v2);

    // Stage and record the same RRN in both orgs via runtime role
    let run_a = seed_import_run(&pool, a.org_uuid).await;
    let run_b = seed_import_run(&pool, b.org_uuid).await;
    let s_a = sealed_a.clone();
    with_org_conn(&a.rt, a.org, move |tx| {
        Box::pin(async move {
            identities::stage(
                tx,
                a.org_uuid,
                run_a,
                &[StagedIdentity {
                    source_key: "r1".into(),
                    sealed: s_a,
                    id_type: None,
                }],
            )
            .await?;
            identities::record(
                tx,
                a.org_uuid,
                *a.actor.as_uuid(),
                run_a,
                &BTreeMap::from([("r1".into(), emp_a)]),
                None,
            )
            .await
        })
    })
    .await
    .unwrap();

    // Stage in org_b too and assert stored staged hashes differ between org_a and org_b
    let s_b = sealed_b.clone();
    with_org_conn(&b.rt, b.org, move |tx| {
        Box::pin(async move {
            identities::stage(
                tx,
                b.org_uuid,
                run_b,
                &[StagedIdentity {
                    source_key: "r1".into(),
                    sealed: s_b,
                    id_type: None,
                }],
            )
            .await
        })
    })
    .await
    .unwrap();

    // Transplant org_a's rrn_hmac_v2 into org_b's employee_rrn row for emp_b
    sqlx::query(
        "INSERT INTO employee_rrn (org_id, employee_id, rrn_hmac, hmac_key_version, \
         rrn_hmac_v2, blind_index_version, ciphertext, nonce, dek_wrapped, dek_nonce, \
         key_version, masked, alg_id, kek_id, msg_id, commitment_tag, source, recorded_by) \
         VALUES ($1,$2,$3,1,$4,2,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'FORM',$15)",
    )
    .bind(b.org_uuid)
    .bind(emp_b)
    .bind(&sealed_b.hmac)
    .bind(sealed_a.hmac_v2.as_deref())
    .bind(&sealed_b.ciphertext)
    .bind(&sealed_b.nonce)
    .bind(&sealed_b.dek_wrapped)
    .bind(&sealed_b.dek_nonce)
    .bind(sealed_b.key_version)
    .bind(&sealed_b.masked)
    .bind(sealed_b.alg_id.as_deref())
    .bind(sealed_b.kek_id.as_deref())
    .bind(sealed_b.msg_id.as_deref())
    .bind(sealed_b.commitment_tag.as_deref())
    .bind(b.actor.as_uuid())
    // rls-arming: ok negative transplant test seeds transplanted row as owner
    .execute(&pool)
    .await
    .unwrap();

    // 1. people_for_rows in org_b using org_b's v2 hash MUST NOT match emp_b (which holds org_a's tag)
    let lookup_row = ImportRow {
        source_key: "probe".into(),
        name: "Unrelated".into(),
        rrn_hmac: Some(sealed_b.hmac.clone()),
        rrn_hmac_v2: sealed_b.hmac_v2.clone(),
        rrn_hmac_v2_candidates: vault.blind_index_v2_candidates(b.org_uuid, &rrn),
        ..ImportRow::default()
    };
    let found = with_org_conn(&b.rt, b.org, move |tx| {
        Box::pin(async move { plan_facts::people_for_rows(tx, b.org_uuid, &[lookup_row]).await })
    })
    .await
    .unwrap();
    assert!(
        found.is_empty(),
        "org_a transplanted tag must never match org_b lookup"
    );

    // 2. identities::record in org_b for emp_b2 using org_b's staged row MUST NOT trigger rrn_in_use
    let vault_ref = vault.clone();
    let recorded = with_org_conn(&b.rt, b.org, move |tx| {
        Box::pin(async move {
            identities::record(
                tx,
                b.org_uuid,
                *b.actor.as_uuid(),
                run_b,
                &BTreeMap::from([("r1".into(), emp_b2)]),
                Some(vault_ref.as_ref()),
            )
            .await
        })
    })
    .await
    .unwrap();
    assert_eq!(recorded, 1);

    // 3. vault.open(org_b, &sealed_a) fails closed
    assert_eq!(vault.open(b.org_uuid, &sealed_a), Err(VaultError));

    // 4. Transplanted SealedRrn in org_b's data_import_row_identities fails closed in record()
    let run_b_bad = seed_import_run(&pool, b.org_uuid).await;
    let emp_b3 = seed_employee(&pool, b.org_uuid, "B-03", "BobThree").await;
    let s_bad = sealed_a.clone();
    let vault_ref2 = vault.clone();
    let err = with_org_conn(&b.rt, b.org, move |tx| {
        Box::pin(async move {
            identities::stage(
                tx,
                b.org_uuid,
                run_b_bad,
                &[StagedIdentity {
                    source_key: "r-bad".into(),
                    sealed: s_bad,
                    id_type: None,
                }],
            )
            .await?;
            identities::record(
                tx,
                b.org_uuid,
                *b.actor.as_uuid(),
                run_b_bad,
                &BTreeMap::from([("r-bad".into(), emp_b3)]),
                Some(vault_ref2.as_ref()),
            )
            .await
        })
    })
    .await
    .unwrap_err();
    assert_eq!(err.code, "rrn_vault_unavailable");

    // 5. RLS isolation: org_a console_rt connection cannot read or update org_b's employee_rrn
    let (visible, updated) = with_org_conn(&a.rt, a.org, move |tx| {
        Box::pin(async move {
            let count: i64 =
                sqlx::query_scalar("SELECT count(*) FROM employee_rrn WHERE org_id = $1")
                    .bind(b.org_uuid)
                    .fetch_one(tx.as_mut())
                    .await?;
            let rows =
                sqlx::query("UPDATE employee_rrn SET blind_index_version = 2 WHERE org_id = $1")
                    .bind(b.org_uuid)
                    .execute(tx.as_mut())
                    .await?
                    .rows_affected();
            Ok::<_, console_hr_adapter_postgres::HrError>((count, rows))
        })
    })
    .await
    .unwrap();
    assert_eq!(visible, 0);
    assert_eq!(updated, 0);

    // Verify org_a and org_b rows remain distinct on disk
    let rows = sqlx::query("SELECT org_id, rrn_hmac_v2 FROM employee_rrn")
        // rls-arming: ok owner verification of stored bytes across both test orgs
        .fetch_all(&pool)
        .await
        .unwrap();
    let mut org_a_hash = None;
    let mut org_b_hashes = Vec::new();
    for r in rows {
        let oid: Uuid = r.get("org_id");
        let h: Option<Vec<u8>> = r.get("rrn_hmac_v2");
        if oid == a.org_uuid {
            org_a_hash = h;
        } else {
            org_b_hashes.push(h);
        }
    }
    assert_eq!(org_a_hash, sealed_a.hmac_v2);
    assert!(org_b_hashes.contains(&sealed_b.hmac_v2));
}
