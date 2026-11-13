// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, dead_code)]
#[path = "emp_create/fixture.rs"]
mod fixture;
#[path = "registration_prepare/overlap.rs"]
mod overlap;
#[path = "support/trail_queries.rs"]
mod trail_queries;

use console_hr_adapter_postgres::directory::create_prepare::{
    RegistrationInput, prepare_registrations, reserve_create_keys,
};
use console_hr_adapter_postgres::directory::normalize::normalize_create_employee_request;
use console_hr_adapter_postgres::directory::types::NormalizedCreateEmployeeRequest;
use sqlx::{PgPool, Postgres, Transaction};
use tracing::instrument::WithSubscriber;
use uuid::Uuid;

async fn transaction(f: &fixture::Fixture) -> Transaction<'static, Postgres> {
    let mut tx = f.rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(f.principal.org_id.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx
}

fn observe() -> trail_queries::Queries {
    static DISPATCH: std::sync::OnceLock<tracing::Dispatch> = std::sync::OnceLock::new();
    DISPATCH.get_or_init(|| tracing::Dispatch::new(trail_queries::Queries::default()));
    trail_queries::Queries::default()
}

const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn hashes(requests: &[NormalizedCreateEmployeeRequest]) -> Vec<String> {
    requests
        .iter()
        .map(|r| {
            console_hr_adapter_postgres::digest::sha256_hex(
                serde_json::to_string(r).unwrap().as_bytes(),
            )
        })
        .collect()
}

fn inputs<'a>(
    requests: &'a [NormalizedCreateEmployeeRequest],
    hashes: &'a [String],
) -> Vec<RegistrationInput<'a>> {
    requests
        .iter()
        .zip(hashes)
        .map(|(request, hash)| RegistrationInput {
            request,
            request_hash: hash,
            employee_id: Uuid::new_v4(),
        })
        .collect()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn preparation_has_constant_round_trips_for_three_thousand_registrations(pool: PgPool) {
    let f = fixture::fixture(pool).await;
    for people in [3, 1_000, 2_000, 3_000] {
        let requests: Vec<_> = (0..people)
            .map(|n| {
                let mut body = f.body(&format!("prepare-{n}"), "REGULAR");
                body.employee_number = format!("SYNTHETIC-{n}");
                normalize_create_employee_request(body).unwrap()
            })
            .collect();
        let hashes = hashes(&requests);
        let commands = inputs(&requests, &hashes);
        let mut tx = transaction(&f).await;
        let queries = observe();
        let started = std::time::Instant::now();
        let prepared = prepare_registrations(&mut tx, *f.principal.org_id.as_uuid(), &commands)
            .with_subscriber(queries.clone())
            .await
            .unwrap();
        eprintln!(
            "prepare {people} registrations: {:?}, {} statements",
            started.elapsed(),
            queries.statements().len()
        );
        assert_eq!(prepared.len(), people);
        assert_eq!(
            queries.statements().len(),
            3,
            "two reservation statements and one reference read"
        );
        for (input, row) in commands.iter().zip(&prepared) {
            assert_eq!(row.employee_id, input.employee_id);
            assert!(!row.replayed);
            assert_eq!(row.org_unit, "site");
            assert_eq!(row.employee_number, input.request.employee_number);
        }
        tx.rollback().await.unwrap();
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn preparation_deduplicates_keys_and_allocates_numbers_in_input_order(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let mut existing = f.body("existing", "REGULAR");
    existing.employee_number = "E-000010".into();
    let existing_id = f.create(existing).await.unwrap().employee_id();
    sqlx::query("INSERT INTO employee_number_changes (org_id,id,employee_id,from_number,to_number,effective_date,reason_code,changed_by) \
        VALUES ($1,$2,$3,'E-000040','E-000010',CURRENT_DATE,'합성 번호 변경',$4)")
        .bind(f.principal.org_id.as_uuid()).bind(Uuid::new_v4()).bind(existing_id)
        .bind(f.principal.user_id.as_uuid()).execute(&pool).await.unwrap();
    let requests: Vec<_> = ["auto-first", "manual", "auto-last"]
        .iter()
        .map(|key| {
            let mut body = f.body(key, "REGULAR");
            if *key == "manual" {
                body.employee_number = "E-000050".into();
            }
            normalize_create_employee_request(body).unwrap()
        })
        .collect();
    let hashes = hashes(&requests);
    let mut commands = inputs(&requests, &hashes);
    commands.push(RegistrationInput {
        request: &requests[0],
        request_hash: &hashes[0],
        employee_id: Uuid::new_v4(),
    });
    let mut tx = transaction(&f).await;
    let queries = observe();
    let result = prepare_registrations(&mut tx, *f.principal.org_id.as_uuid(), &commands)
        .with_subscriber(queries.clone())
        .await
        .unwrap();
    assert_eq!(
        result
            .iter()
            .map(|r| r.employee_number.as_str())
            .collect::<Vec<_>>(),
        ["E-000041", "E-000050", "E-000051", "E-000041"]
    );
    assert_eq!(result[3].employee_id, result[0].employee_id);
    assert!(result[3].replayed);
    assert_eq!(
        queries
            .statements()
            .iter()
            .filter(|sql| sql.contains("employee_number_seq:"))
            .count(),
        1
    );
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM employee_create_idempotency WHERE org_id=$1")
            .bind(f.principal.org_id.as_uuid())
            .fetch_one(tx.as_mut())
            .await
            .unwrap();
    assert_eq!(count, 4, "one existing key plus three fresh keys");
    tx.rollback().await.unwrap();
    let mut tx = transaction(&f).await;
    assert!(
        prepare_registrations(&mut tx, *f.principal.org_id.as_uuid(), &[])
            .await
            .unwrap()
            .is_empty()
    );
    tx.rollback().await.unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn preparation_preserves_replays_conflicts_and_tenant_boundaries(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let foreign = fixture::fixture(pool.clone()).await;
    let existing = f
        .create(f.body("replay", "REGULAR"))
        .await
        .unwrap()
        .employee_id();
    let mut replay = normalize_create_employee_request(f.body("replay", "REGULAR")).unwrap();
    let hash = console_hr_adapter_postgres::digest::sha256_hex(
        serde_json::to_string(&replay).unwrap().as_bytes(),
    );
    replay.home_branch_id = Some(foreign.branch);
    replay.org_unit_id = Some(foreign.unit);
    let mut tx = transaction(&f).await;
    let rows = prepare_registrations(
        &mut tx,
        *f.principal.org_id.as_uuid(),
        &[RegistrationInput {
            request: &replay,
            request_hash: &hash,
            employee_id: Uuid::new_v4(),
        }],
    )
    .await
    .unwrap();
    assert_eq!(rows[0].employee_id, existing);
    assert!(
        rows[0].replayed,
        "stored receipts skip new reference validation"
    );
    tx.rollback().await.unwrap();
    for keys in [
        vec![("new", HASH_A), ("new", HASH_B)],
        vec![("fresh", HASH_A), ("replay", HASH_B)],
    ] {
        let mut tx = transaction(&f).await;
        let queries = observe();
        let error = reserve_create_keys(&mut tx, *f.principal.org_id.as_uuid(), &keys)
            .with_subscriber(queries.clone())
            .await
            .unwrap_err();
        assert_eq!(error.code, "idempotency_key_reused");
        assert_eq!(
            queries.statements().len(),
            if keys[0].0 == "new" { 0 } else { 2 }
        );
        tx.rollback().await.unwrap();
    }
    for field in ["branch", "unit", "legacy_unit", "position", "number"] {
        let mut body = f.body("bad-reference", "REGULAR");
        let expected = match field {
            "branch" => {
                body.home_branch_id = Some(foreign.branch);
                404
            }
            "unit" => {
                body.org_unit_id = Some(foreign.unit);
                404
            }
            "legacy_unit" => {
                body.org_unit_id = None;
                body.org_unit = foreign.unit.to_string();
                422
            }
            "position" => {
                body.position = Uuid::new_v4().to_string();
                422
            }
            _ => {
                body.employee_number = "REPEATED".into();
                409
            }
        };
        let first = normalize_create_employee_request(body).unwrap();
        let mut second = normalize_create_employee_request(f.body("second", "REGULAR")).unwrap();
        second.employee_number = "REPEATED".into();
        let requests = [first, second];
        let hashes = hashes(&requests);
        let mut tx = transaction(&f).await;
        let error = prepare_registrations(
            &mut tx,
            *f.principal.org_id.as_uuid(),
            &inputs(&requests, &hashes),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status.as_u16(), expected, "{field}: {error:?}");
        tx.rollback().await.unwrap();
    }
    let mut tx = transaction(&foreign).await;
    let own = reserve_create_keys(
        &mut tx,
        *foreign.principal.org_id.as_uuid(),
        &[("replay", HASH_A)],
    )
    .await
    .unwrap();
    assert_eq!(own["replay"], None, "another tenant's key must not replay");
    tx.rollback().await.unwrap();
    let mut tx = transaction(&f).await;
    assert!(
        reserve_create_keys(
            &mut tx,
            *foreign.principal.org_id.as_uuid(),
            &[("foreign-write", HASH_A)]
        )
        .await
        .is_err()
    );
    tx.rollback().await.unwrap();
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM employee_create_idempotency WHERE org_id=$1")
            .bind(f.principal.org_id.as_uuid())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 1, "every failed batch rolled back its fresh keys");
}
