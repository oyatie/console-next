// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

async fn unconfirmed_backfill(pool: &PgPool) -> (World, Uuid) {
    let (w, c) = prepared(pool, "2026-10-01", "2026-10-13").await;
    let id: Uuid = c["id"].as_str().unwrap().parse().unwrap();
    let head = Uuid::new_v4();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role=replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    // Historical backfill linked cases to placeholder dates awaiting confirmation.
    sqlx::query("INSERT INTO employment_heads(org_id,id,employee_id,valid_from,hire_date,service_start_date,severance_start_date,needs_confirmation) VALUES ($1,$2,$3,'2026-10-01T00:00:00+09:00','2026-10-01','2026-10-01','2026-10-01',true)")
        .bind(w.org).bind(head).bind(w.in_a).execute(tx.as_mut()).await.unwrap();
    sqlx::query("UPDATE employee_exit_cases SET employment_id=$2 WHERE id=$1")
        .bind(id)
        .bind(head)
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE employees SET hire_on=NULL,hire_date=NULL WHERE id=$1")
        .bind(w.in_a)
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    (w, id)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unconfirmed_head_without_hire_fact_needs_source(pool: PgPool) {
    let (w, id) = unconfirmed_backfill(&pool).await;
    let mut tx = pool.begin().await.unwrap();
    console_hr_adapter_postgres::exits::settlement_store::upsert_exit_settlement_package(
        &mut tx,
        w.org,
        id,
        Some(serde_json::from_value(wage_input()).unwrap()),
    )
    .await
    .unwrap();
    let p: Value = sqlx::query_scalar(
        "SELECT to_jsonb(p) FROM employee_exit_settlement_packages p WHERE exit_case_id=$1",
    )
    .bind(id)
    .fetch_one(tx.as_mut())
    .await
    .unwrap();
    assert_eq!(p["status"], "NEEDS_SOURCE");
    assert!(p["severance_pay_won"].is_null());
    assert!(p["statutory_basis"]["severance_eligibility"].is_null());
    assert!(
        p["missing_source_fields"]
            .as_array()
            .unwrap()
            .contains(&json!("hire_date"))
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unconfirmed_head_uses_corrected_hire_fact_for_severance(pool: PgPool) {
    let (w, id) = unconfirmed_backfill(&pool).await;
    sqlx::query("UPDATE employees SET hire_on='2020-01-01',hire_date='2020-01-01' WHERE id=$1")
        .bind(w.in_a)
        .execute(&pool)
        .await
        .unwrap();
    let result =
        w.hr.draft_exit_approval(
            w.hr(w.hr_one),
            id,
            serde_json::from_value(json!({"submit":false,"settlement_input":wage_input()}))
                .unwrap(),
        )
        .await
        .unwrap();
    let p = result.settlement_package.unwrap();
    assert!(p.statutory_basis["severance_eligibility"].is_null());
    assert!(p.severance_pay_won.unwrap() > 0);
    assert!(p.service_days.unwrap() > 365);
    assert!(p.missing_source_fields.is_empty());
}
