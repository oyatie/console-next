// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[path = "support/rrn_blind_index.rs"]
mod rrn_support;

use console_hr_adapter_postgres::import::{identities, plan_facts, sheet::StagedIdentity};
use console_hr_adapter_postgres::rrn::{FieldRevealRequest, RevealField, reveal_binding};
use console_hr_domain::import::plan::ImportRow;
use console_hr_domain::import::rrn_value::{Rrn, RrnVault};
use console_platform_auth::{MobilePasskeyStepUpAssertion, MobilePasskeyStepUpEnvelope};
use console_platform_db::with_org_conn;
use console_platform_test_support::soft_passkey::{SoftKey, passkey_service};
use rrn_support::{
    TestEnvVault, insert_v1_employee_rrn, seed_employee, seed_import_run, seed_tenant,
};
use serde_json::json;
use sqlx::{PgPool, Row};
use std::collections::BTreeMap;
use std::io::Write;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

#[derive(Clone, Default)]
struct LogSink(Arc<Mutex<Vec<u8>>>);
impl Write for LogSink {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogSink {
    type Writer = Self;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn t3_pre_backfill_dual_read_matches_and_catches_v1_v2_conflicts(pool: PgPool) {
    let vault = TestEnvVault::new(0x31, 0x32);
    let t = seed_tenant(&pool, "t3", vault.clone()).await;
    let emp1 = seed_employee(&pool, t.org_uuid, "E-1", "KimOne").await;
    let emp2 = seed_employee(&pool, t.org_uuid, "E-2", "KimTwo").await;

    // Seed emp1 with legacy v1-only employee_rrn (rrn_hmac_v2 IS NULL)
    let rrn = Rrn::parse("850505-2234567").unwrap();
    let sealed_v1 = vault.seal(t.org_uuid, &rrn).unwrap();
    insert_v1_employee_rrn(&pool, t.org_uuid, emp1, *t.actor.as_uuid(), &sealed_v1).await;

    // people_for_rows with v2 ImportRow matches legacy v1 employee_rrn
    let row = ImportRow {
        source_key: "k1".into(),
        name: "Unmatched".into(),
        rrn_hmac: Some(sealed_v1.hmac.clone()),
        rrn_hmac_v2: sealed_v1.hmac_v2.clone(),
        rrn_hmac_v2_candidates: vault.blind_index_v2_candidates(t.org_uuid, &rrn),
        ..ImportRow::default()
    };
    let people = with_org_conn(&t.rt, t.org, move |tx| {
        Box::pin(async move { plan_facts::people_for_rows(tx, t.org_uuid, &[row]).await })
    })
    .await
    .unwrap();
    assert_eq!(people.len(), 1);
    assert_eq!(people[0].id, emp1);

    // identities::record refuses v2 staged row colliding with v1 employee_rrn for emp2
    let run = seed_import_run(&pool, t.org_uuid).await;
    let s = sealed_v1.clone();
    let v_ref = vault.clone();
    let err = with_org_conn(&t.rt, t.org, move |tx| {
        Box::pin(async move {
            identities::stage(
                tx,
                t.org_uuid,
                run,
                &[StagedIdentity {
                    source_key: "r-dup".into(),
                    sealed: s,
                }],
            )
            .await?;
            identities::record(
                tx,
                t.org_uuid,
                *t.actor.as_uuid(),
                run,
                &BTreeMap::from([("r-dup".into(), emp2)]),
                Some(v_ref.as_ref()),
            )
            .await
        })
    })
    .await
    .unwrap_err();
    assert_eq!((err.status.as_u16(), err.code), (409, "rrn_in_use"));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn t4_t5_t6_t7_batched_backfill_rollback_audit_and_zero_leakage(pool: PgPool) {
    let vault = TestEnvVault::new(0x41, 0x42);
    let a = seed_tenant(&pool, "bf-a", vault.clone()).await;
    let b = seed_tenant(&pool, "bf-b", vault.clone()).await;

    let rrns = [
        "900101-1234567",
        "850505-2234567",
        "920304-1000000",
        "880808-2000000",
        "050101-3234567",
    ];
    let mut emp_a_ids = Vec::new();
    for (idx, rrn_str) in rrns.iter().enumerate() {
        let emp = seed_employee(&pool, a.org_uuid, &format!("A-{idx}"), "Alpha").await;
        let sealed = vault
            .seal(a.org_uuid, &Rrn::parse(rrn_str).unwrap())
            .unwrap();
        insert_v1_employee_rrn(&pool, a.org_uuid, emp, *a.actor.as_uuid(), &sealed).await;
        emp_a_ids.push(emp);
    }
    // Also add 1 already-v2 row in org_a and 2 v1 rows in org_b
    let emp_a_v2 = seed_employee(&pool, a.org_uuid, "A-V2", "AlphaV2").await;
    let rrn_a_v2 = Rrn::parse("910202-1234567").unwrap();
    let sealed_a_v2 = vault.seal(a.org_uuid, &rrn_a_v2).unwrap();
    let run_a_v2 = seed_import_run(&pool, a.org_uuid).await;
    with_org_conn(&a.rt, a.org, move |tx| {
        Box::pin(async move {
            identities::stage(
                tx,
                a.org_uuid,
                run_a_v2,
                &[StagedIdentity {
                    source_key: "k".into(),
                    sealed: sealed_a_v2,
                }],
            )
            .await?;
            identities::record(
                tx,
                a.org_uuid,
                *a.actor.as_uuid(),
                run_a_v2,
                &BTreeMap::from([("k".into(), emp_a_v2)]),
                None,
            )
            .await
        })
    })
    .await
    .unwrap();

    for (idx, rrn_str) in ["900101-1234567", "850505-2234567"].iter().enumerate() {
        let emp = seed_employee(&pool, b.org_uuid, &format!("B-{idx}"), "Beta").await;
        let sealed = vault
            .seal(b.org_uuid, &Rrn::parse(rrn_str).unwrap())
            .unwrap();
        insert_v1_employee_rrn(&pool, b.org_uuid, emp, *b.actor.as_uuid(), &sealed).await;
    }

    // T4 mid-backfill: 1 batch of size 2 in org_a leaves 3 rows at v1
    let first_batch =
        a.hr.backfill_rrn_blind_index_batch(a.org, vault.clone(), 2, 2)
            .await
            .unwrap();
    assert_eq!(first_batch, 2);
    let remaining_a: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM employee_rrn WHERE org_id = $1 AND rrn_hmac_v2 IS NULL",
    )
    .bind(a.org_uuid)
    // rls-arming: ok owner verification of mid-backfill state
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(remaining_a, 3);

    // T4 full completion + T6 log capture
    let sink = LogSink::default();
    let subscriber = tracing_subscriber::fmt().with_writer(sink.clone()).finish();
    let _guard = tracing::subscriber::set_default(subscriber);

    let total_updated =
        a.hr.backfill_rrn_blind_indexes(vault.clone())
            .await
            .unwrap();
    assert_eq!(total_updated, 5); // 3 remaining in org_a + 2 in org_b

    let rerun =
        a.hr.backfill_rrn_blind_indexes(vault.clone())
            .await
            .unwrap();
    assert_eq!(rerun, 0);

    // T7: check backfill audit events (actor IS NULL, SCHEDULER, counts/version only, no RRN/HMAC)
    let audit_rows = sqlx::query(
        "SELECT actor, source, after_snap::text AS snap FROM audit_events \
         WHERE action = 'employee.rrn_blind_index_backfill' ORDER BY created_at",
    )
    // rls-arming: ok owner inspection of audit_events for backfill verification
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(audit_rows.len(), 3); // 1 mid-batch + 1 remaining org_a + 1 org_b; 0 on rerun
    for row in &audit_rows {
        let actor: Option<Uuid> = row.get("actor");
        let source: String = row.get("source");
        let snap: String = row.get("snap");
        assert!(actor.is_none());
        assert_eq!(source, "SCHEDULER");
        assert!(snap.contains("to_blind_index_version"));
        assert!(!snap.contains("900101"));
    }

    // T5: N-1 rollback inserts a new v1-only row after backfill; dual-read & backfill still work
    let emp_n1 = seed_employee(&pool, a.org_uuid, "A-N1", "Rollback").await;
    let rrn_n1 = Rrn::parse("870707-1234567").unwrap();
    let sealed_n1 = vault.seal(a.org_uuid, &rrn_n1).unwrap();
    insert_v1_employee_rrn(&pool, a.org_uuid, emp_n1, *a.actor.as_uuid(), &sealed_n1).await;
    assert_eq!(
        a.hr.backfill_rrn_blind_indexes(vault.clone())
            .await
            .unwrap(),
        1
    );

    // T7 + T5: rrn_reveal on backfilled row writes immutable audit event & opens AEAD
    let mut key = SoftKey::enroll(&pool, a.org, a.actor).await;
    let passkeys = passkey_service();
    let binding = reveal_binding(emp_a_ids[0], "RRN", "IDENTITY_VERIFICATION");
    let start = passkeys
        .start_mobile_step_up(&pool, *a.actor.as_uuid(), binding.clone())
        .await
        .unwrap();
    let mut challenge = serde_json::to_value(start.challenge).unwrap();
    challenge["publicKey"]["allowCredentials"] =
        json!([{ "type": "public-key", "id": key.credential_id() }]);
    let step_up = MobilePasskeyStepUpEnvelope {
        binding,
        assertion: MobilePasskeyStepUpAssertion {
            ceremony_id: start.ceremony_id,
            credential: serde_json::from_value(key.assert(&challenge).unwrap()).unwrap(),
        },
    };
    let revealed =
        a.hr.reveal_field(
            a.principal.clone(),
            emp_a_ids[0],
            FieldRevealRequest {
                field: RevealField::Rrn,
                reason_code: "IDENTITY_VERIFICATION".into(),
                note: None,
                step_up: Some(step_up),
            },
            Some(vault.as_ref()),
            Some(&passkeys),
        )
        .await
        .unwrap();
    assert_eq!(revealed.value, json!("900101-1234567"));

    // Column-scoped privilege check: envelope columns became re-sealable in PR-CRYPTO-3,
    // while identity, blind-index v1, masked display, and provenance columns remain immutable to console_rt.
    for stmt in [
        "UPDATE employee_rrn SET rrn_hmac = decode('00', 'hex') WHERE org_id = $1",
        "UPDATE employee_rrn SET masked = '000000-1******' WHERE org_id = $1",
        "UPDATE employee_rrn SET org_id = $1 WHERE org_id = $1",
        "UPDATE employee_rrn SET recorded_by = $1 WHERE org_id = $1",
    ] {
        let priv_err = with_org_conn(&a.rt, a.org, move |tx| {
            Box::pin(async move {
                sqlx::query(stmt)
                    .bind(a.org_uuid)
                    .execute(tx.as_mut())
                    .await
                    .map_err(console_hr_adapter_postgres::HrError::from)
            })
        })
        .await
        .unwrap_err();
        assert_eq!(priv_err.status.as_u16(), 500);
    }

    // T6: captured logs never contain RRN digits or HMAC hex
    let logs = String::from_utf8_lossy(&sink.0.lock().unwrap()).into_owned();
    assert!(!logs.contains("900101"));
    assert!(!logs.contains("1234567"));
    let v2_hex: String = vault
        .blind_index(a.org_uuid, &Rrn::parse("900101-1234567").unwrap())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert!(!logs.contains(&v2_hex));
}
