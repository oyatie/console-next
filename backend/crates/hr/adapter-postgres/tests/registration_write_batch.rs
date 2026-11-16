// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, dead_code)]
#[path = "emp_create/fixture.rs"]
mod fixture;
#[path = "support/trail_queries.rs"]
mod trail_queries;

use console_hr_adapter_postgres::clock::today_kst;
use console_hr_adapter_postgres::directory::{
    create_core::create_employees_core, create_prepare::RegistrationInput,
    normalize::normalize_create_employee_request, types::NormalizedCreateEmployeeRequest,
};
use sqlx::PgPool;
use tracing::instrument::WithSubscriber;
use uuid::Uuid;

#[path = "registration_write_batch/support.rs"]
mod support;
use support::*;

#[path = "registration_write_batch/order.rs"]
mod order;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn registration_batches_heads_persons_profiles_and_replays_in_input_order(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let requests = requests(&f, &pool).await;
    let hashes = self::hashes(&requests);
    let mut inputs = inputs(&requests, &hashes);
    inputs.push(RegistrationInput {
        employee_id: Uuid::new_v4(),
        ..inputs[0]
    });
    let queries = observe();
    let mut tx = transaction(&f).await;
    let rows = create_employees_core(
        &mut tx,
        *f.principal.org_id.as_uuid(),
        f.principal.user_id,
        &inputs,
    )
    .with_subscriber(queries.clone())
    .await
    .unwrap();
    assert_eq!(rows.len(), 4);
    for (row, input) in rows.iter().zip(&inputs).take(3) {
        assert_eq!(row.0.employee_id(), input.employee_id);
        assert!(!row.1);
    }
    assert_eq!(rows[3].0.employee_id(), inputs[0].employee_id);
    assert!(rows[3].1);
    let ids: Vec<_> = rows.iter().take(3).map(|r| r.0.employee_id()).collect();
    let counts: (i64,i64,i64,i64,i64,i64,i64,i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM employees WHERE id=ANY($1)), \
        (SELECT count(*) FROM employee_employment_profiles WHERE employee_id=ANY($1)), \
        (SELECT count(*) FROM employee_person_bindings WHERE employee_id=ANY($1)), \
        (SELECT count(*) FROM person_revisions WHERE person_id=ANY($1) AND origin='command'), \
        (SELECT count(*) FROM person_revisions WHERE person_id=ANY($1) AND origin='binding'), \
        (SELECT count(*) FROM employment_source_bindings WHERE employee_id=ANY($1)), \
        (SELECT count(*) FROM employee_lifecycle_events WHERE employee_id=ANY($1) AND state='APPLIED'), \
        (SELECT count(*) FROM employee_lifecycle_events WHERE employee_id=ANY($1) AND state='SCHEDULED')")
        .bind(&ids).fetch_one(tx.as_mut()).await.unwrap();
    // Profile phone projection appends a binding revision after each canonical create.
    assert_eq!(counts, (3, 3, 3, 3, 3, 2, 2, 1));
    let profiles: Vec<(Uuid, serde_json::Value)> = sqlx::query_as(
        "SELECT e.id, jsonb_build_object('name',e.name,'hire',e.hire_on::text, \
         'company',e.company,'number',e.employee_number,'unit',e.org_unit,'unit_id',e.org_unit_id, \
         'position',e.position,'site',e.worksite_name,'hash',p.request_hash, \
         'key',p.idempotency_key,'kind',p.employment_type,'phone',p.phone_e164,'pay',p.base_pay::text, \
         'start',p.contract_start_date::text,'end',p.contract_end_date::text) \
         FROM employees e JOIN employee_employment_profiles p ON p.employee_id=e.id \
         WHERE e.id=ANY($1)",
    )
    .bind(&ids)
    .fetch_all(tx.as_mut())
    .await
    .unwrap();
    assert_eq!(profiles.len(), requests.len());
    for input in inputs.iter().take(requests.len()) {
        let request = input.request;
        let (_, profile) = profiles
            .iter()
            .find(|(id, _)| *id == input.employee_id)
            .unwrap();
        assert_eq!(
            *profile,
            serde_json::json!({
                "name": request.name, "hire": request.hire_date, "key": request.idempotency_key,
                "company": request.company, "number": request.employee_number,
                "unit": request.org_unit, "unit_id": request.org_unit_id,
                "position": request.position, "site": request.site, "hash": input.request_hash,
                "kind": request.employment_type, "phone": request.phone_e164, "pay": request.base_pay,
                "start": request.contract_start_date, "end": request.contract_end_date,
            })
        );
    }
    let pre_hire: String =
        sqlx::query_scalar("SELECT employment_status FROM employees WHERE id=$1")
            .bind(ids[2])
            .fetch_one(tx.as_mut())
            .await
            .unwrap();
    assert_eq!(pre_hire, "PRE_HIRE");
    tx.commit().await.unwrap();
    assert_batched(&queries, 1);

    let queries = observe();
    let mut tx = transaction(&f).await;
    let replay = create_employees_core(
        &mut tx,
        *f.principal.org_id.as_uuid(),
        f.principal.user_id,
        &inputs,
    )
    .with_subscriber(queries.clone())
    .await
    .unwrap();
    for (first, replay) in rows.iter().zip(&replay) {
        assert_eq!(first.0.employee_id(), replay.0.employee_id());
        assert!(replay.1);
    }
    assert_batched(&queries, 0);
    assert!(
        create_employees_core(
            &mut tx,
            *f.principal.org_id.as_uuid(),
            f.principal.user_id,
            &[]
        )
        .await
        .unwrap()
        .is_empty()
    );
    tx.commit().await.unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn registration_batch_conflicts_roll_back_all_writes_and_keys(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let requests = requests(&f, &pool).await;
    let hashes = self::hashes(&requests);
    let commands = inputs(&requests, &hashes);
    let before = counts(&pool, &f).await;
    // A database refusal after head insertion must roll back every owner, including Persons.
    sqlx::query("ALTER TABLE employee_employment_profiles ADD CONSTRAINT reject_contract CHECK (employment_type <> 'CONTRACT')")
        .execute(&pool).await.unwrap();
    let mut tx = transaction(&f).await;
    assert!(
        create_employees_core(
            &mut tx,
            *f.principal.org_id.as_uuid(),
            f.principal.user_id,
            &commands
        )
        .await
        .is_err()
    );
    tx.rollback().await.unwrap();
    assert_eq!(
        counts(&pool, &f).await,
        before,
        "the complete batch rolled back"
    );
    sqlx::query("ALTER TABLE employee_employment_profiles DROP CONSTRAINT reject_contract")
        .execute(&pool)
        .await
        .unwrap();
    let hashes = self::hashes(&requests);
    let commands = inputs(&requests, &hashes);
    let queries = observe();
    let mut tx = transaction(&f).await;
    create_employees_core(
        &mut tx,
        *f.principal.org_id.as_uuid(),
        f.principal.user_id,
        &commands,
    )
    .with_subscriber(queries.clone())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_batched(&queries, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn registration_batch_revalidates_actor_and_tenant_before_writes(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let foreign = fixture::fixture(pool.clone()).await;
    let mut requests = requests(&f, &pool).await;
    requests[1].org_unit_id = Some(foreign.unit);
    let hashes = self::hashes(&requests);
    let commands = inputs(&requests, &hashes);
    let mut tx = transaction(&f).await;
    let error = create_employees_core(
        &mut tx,
        *f.principal.org_id.as_uuid(),
        f.principal.user_id,
        &commands,
    )
    .await
    .unwrap_err();
    assert_eq!(error.status.as_u16(), 404);
    tx.rollback().await.unwrap();
    sqlx::query("UPDATE users SET is_active=false WHERE id=$1")
        .bind(f.principal.user_id.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = transaction(&f).await;
    let error = create_employees_core(
        &mut tx,
        *f.principal.org_id.as_uuid(),
        f.principal.user_id,
        &commands,
    )
    .await
    .unwrap_err();
    assert_eq!(error.status.as_u16(), 403);
    tx.rollback().await.unwrap();
    sqlx::query("UPDATE users SET is_active=true WHERE id=$1")
        .bind(f.principal.user_id.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let requests = self::requests(&f, &pool).await;
    let hashes = self::hashes(&requests);
    let commands = inputs(&requests, &hashes);
    let queries = observe();
    let mut tx = transaction(&f).await;
    create_employees_core(
        &mut tx,
        *f.principal.org_id.as_uuid(),
        f.principal.user_id,
        &commands,
    )
    .with_subscriber(queries.clone())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_batched(&queries, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn registration_batch_mixes_stored_replays_with_new_keys(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let mut requests = requests(&f, &pool).await;
    let hashes = self::hashes(&requests);
    let commands = inputs(&requests, &hashes);
    let mut tx = transaction(&f).await;
    let first = create_employees_core(
        &mut tx,
        *f.principal.org_id.as_uuid(),
        f.principal.user_id,
        &commands[..1],
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    drop(commands);
    requests.swap(0, 1);
    let hashes = self::hashes(&requests);
    let commands = inputs(&requests, &hashes);
    let queries = observe();
    let mut tx = transaction(&f).await;
    let mixed = create_employees_core(
        &mut tx,
        *f.principal.org_id.as_uuid(),
        f.principal.user_id,
        &commands,
    )
    .with_subscriber(queries.clone())
    .await
    .unwrap();
    assert_eq!(mixed[0].0.employee_id(), commands[0].employee_id);
    assert!(!mixed[0].1);
    assert_eq!(mixed[1].0.employee_id(), first[0].0.employee_id());
    assert!(mixed[1].1);
    assert_eq!(mixed[2].0.employee_id(), commands[2].employee_id);
    assert!(!mixed[2].1);
    tx.commit().await.unwrap();
    assert_batched(&queries, 1);
}
