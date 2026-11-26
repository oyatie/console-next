// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn registration_heads_follow_number_lock_order_and_results_follow_input_order(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    sqlx::query(
        "CREATE TABLE registration_head_insert_order \
         (seq BIGSERIAL, employee_id UUID NOT NULL, name TEXT NOT NULL, hire_on DATE)",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "CREATE FUNCTION capture_registration_head_order() RETURNS trigger \
         LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN \
         INSERT INTO public.registration_head_insert_order (employee_id,name,hire_on) \
         VALUES (NEW.id,NEW.name,NEW.hire_on); \
         RETURN NEW; END $$",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "CREATE TRIGGER capture_registration_head_order AFTER INSERT ON employees \
        FOR EACH ROW EXECUTE FUNCTION capture_registration_head_order()",
    )
    .execute(&pool)
    .await
    .unwrap();
    let mut requests = requests(&f, &pool).await;
    requests.reverse();
    let hashes = hashes(&requests);
    let commands = inputs(&requests, &hashes);
    let mut tx = transaction(&f).await;
    let rows = create_employees_core(
        &mut tx,
        *f.principal.org_id.as_uuid(),
        f.principal.user_id,
        &commands,
    )
    .await
    .unwrap();
    for (row, input) in rows.iter().zip(&commands) {
        assert_eq!(row.0.employee_id(), input.employee_id);
        assert!(!row.1);
    }
    tx.commit().await.unwrap();
    let heads: Vec<(Uuid, String, Option<String>)> = sqlx::query_as(
        "SELECT employee_id,name,hire_on::text FROM registration_head_insert_order ORDER BY seq",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    for (id, name, hired) in &heads {
        let input = commands
            .iter()
            .find(|input| input.employee_id == *id)
            .unwrap();
        assert_eq!(name, &input.request.name);
        assert_eq!(hired, &input.request.hire_date);
    }
    assert_eq!(
        heads.iter().map(|(id, _, _)| *id).collect::<Vec<_>>(),
        vec![
            commands[2].employee_id,
            commands[1].employee_id,
            commands[0].employee_id
        ],
        "overlapping batches must acquire employee-number locks in the same order"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn registration_batch_mixes_stored_replays_with_new_keys(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let mut requests = requests(&f, &pool).await;
    // The first two employees are same-day namesakes, including when the first is replayed.
    requests[1].name = requests[0].name.clone();
    let hashes = hashes(&requests);
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
    for (detail, _) in &mixed {
        assert!(
            detail.warnings.is_empty(),
            "registration core returned warnings without a reader"
        );
    }
    tx.commit().await.unwrap();
    assert_batched(&queries, 1);
}
