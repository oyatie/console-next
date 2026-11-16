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

async fn draft_with_dates(pool: &PgPool, service: &str, severance: &str) -> (World, Value) {
    let (w, c) = prepared(pool, "2026-10-01", "2026-10-13").await;
    let id: Uuid = c["id"].as_str().unwrap().parse().unwrap();
    let head = Uuid::new_v4();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role=replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("INSERT INTO employment_heads(org_id,id,employee_id,valid_from,hire_date,service_start_date,severance_start_date) VALUES ($1,$2,$3,'2026-10-01T00:00:00+09:00','2026-10-01',$4::text::date,$5::text::date)")
        .bind(w.org).bind(head).bind(w.in_a).bind(service).bind(severance)
        .execute(tx.as_mut()).await.unwrap();
    sqlx::query("UPDATE employee_exit_cases SET employment_id=$2 WHERE id=$1")
        .bind(id)
        .bind(head)
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let draft =
        w.hr.draft_exit_approval(
            w.hr(w.hr_one),
            id,
            serde_json::from_value(json!({"submit":false,"settlement_input":wage_input()}))
                .unwrap(),
        )
        .await
        .unwrap();
    (w, serde_json::to_value(draft).unwrap())
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn continuous_service_qualifies_after_a_recent_severance_reset(pool: PgPool) {
    let (w, c) = draft_with_dates(&pool, "2024-01-01", "2026-10-01").await;
    let p = &c["settlement_package"];
    assert!(p["statutory_basis"]["severance_eligibility"].is_null());
    assert_eq!(p["service_days"], 13);
    // Eligibility retains continuous service; the amount excludes the settled period.
    assert_eq!(p["severance_pay_won"], 122_697);
    let mut tx = pool.begin().await.unwrap();
    let mut context = console_hr_adapter_postgres::exits::store::load_exit_case_context(
        &mut tx,
        w.org,
        c["id"].as_str().unwrap().parse().unwrap(),
        false,
    )
    .await
    .unwrap();
    context.hire_date = Some("2026-10-14".to_owned());
    let input = serde_json::from_value(wage_input()).unwrap();
    let error = console_hr_adapter_postgres::exits::settlement::build_settlement_calculation(
        &context,
        Some(&input),
        Some(1),
    )
    .unwrap_err();
    assert_eq!(error.code, "validation");
    assert!(
        error
            .message
            .contains("exit date must be on or after hire date")
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn short_continuous_service_is_not_qualified_by_an_earlier_severance_date(pool: PgPool) {
    let (_, c) = draft_with_dates(&pool, "2026-10-01", "2024-01-01").await;
    let p = &c["settlement_package"];
    assert_eq!(p["severance_pay_won"], 0);
    assert_eq!(
        p["statutory_basis"]["severance_eligibility"]["reason"],
        "UNDER_SERVICE_YEARS"
    );
    assert_eq!(p["missing_source_fields"], json!([]));
}
