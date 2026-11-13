// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn missing_service_rule_refuses_even_with_full_wages_without_writes(pool: PgPool) {
    let (w, c) = prepared(&pool, "2024-10-13", "2026-10-13").await;
    sqlx::query("DELETE FROM statutory_rules WHERE code='SEVERANCE_MIN_SERVICE_YEARS'")
        .execute(&pool)
        .await
        .unwrap();
    let id = c["id"].as_str().unwrap().parse().unwrap();
    let before: Value = sqlx::query_scalar(
        "SELECT to_jsonb(p) FROM employee_exit_settlement_packages p WHERE exit_case_id=$1",
    )
    .bind(id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let mut tx = pool.begin().await.unwrap();
    let context = console_hr_adapter_postgres::exits::store::load_exit_case_context(
        &mut tx, w.org, id, false,
    )
    .await
    .unwrap();
    let input = serde_json::from_value(wage_input()).unwrap();
    let payable = console_hr_adapter_postgres::exits::settlement::build_settlement_calculation(
        &context,
        Some(&input),
        Some(1),
    )
    .unwrap();
    assert_eq!(payable.0, "READY_FOR_APPROVAL");
    assert!(payable.7.unwrap() > 0);
    let calculation = console_hr_adapter_postgres::exits::settlement::build_settlement_calculation(
        &context,
        Some(&input),
        None,
    )
    .unwrap();
    assert_eq!(calculation.0, "NEEDS_SOURCE");
    assert_eq!(calculation.7, None);
    assert!(calculation.8.contains(&"statutory_rules".to_owned()));
    tx.rollback().await.unwrap();
    for input in [Value::Null, wage_input()] {
        let error =
            w.hr.draft_exit_approval(
                w.hr(w.hr_one),
                id,
                serde_json::from_value(json!({"submit":false,"settlement_input":input})).unwrap(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "severance_statutory_basis_unavailable");
        assert_eq!(error.status, http::StatusCode::CONFLICT);
        assert_eq!(error.errors.unwrap()[0].field, "effective_exit_date");
    }
    let after: Value = sqlx::query_scalar(
        "SELECT to_jsonb(p) FROM employee_exit_settlement_packages p WHERE exit_case_id=$1",
    )
    .bind(id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(after, before);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn zero_service_threshold_refuses_instead_of_calculating(pool: PgPool) {
    let (w, c) = prepared(&pool, "2024-10-13", "2026-10-13").await;
    sqlx::query("UPDATE statutory_rules SET value_num=0 WHERE code='SEVERANCE_MIN_SERVICE_YEARS'")
        .execute(&pool)
        .await
        .unwrap();
    let error =
        w.hr.draft_exit_approval(
            w.hr(w.hr_one),
            c["id"].as_str().unwrap().parse().unwrap(),
            serde_json::from_value(json!({"submit":false,"settlement_input":wage_input()}))
                .unwrap(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "severance_statutory_basis_unavailable");
}
