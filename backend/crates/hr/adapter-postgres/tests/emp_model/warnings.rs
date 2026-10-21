//! Typed warnings survive a detail reload and never disclose pay to directory readers.
use crate::fixture::fixture;
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn wage_notice_is_current_and_redacted_for_readers(pool: PgPool) {
    let f = fixture(pool.clone(), true).await;
    sqlx::query("UPDATE employee_employment_profiles SET base_pay_won = 1, pay_unit = 'HOURLY' WHERE employee_id = $1")
        .bind(f.employee).execute(&pool).await.unwrap();
    let detail =
        f.hr.employee_detail(f.principal.clone(), f.employee)
            .await
            .unwrap();
    let warning = detail
        .warnings
        .iter()
        .find(|w| w.code == "pay_below_minimum_wage")
        .unwrap();
    assert!(warning.floor_won.is_some_and(|floor| floor > 1));
    assert!(warning.employee_ids.is_empty());
    assert!(
        detail
            .redact_for_reader()
            .warnings
            .iter()
            .all(|w| w.code != "pay_below_minimum_wage")
    );
    sqlx::query(
        "UPDATE employee_employment_profiles SET base_pay_won = 1000000 WHERE employee_id = $1",
    )
    .bind(f.employee)
    .execute(&pool)
    .await
    .unwrap();
    let detail =
        f.hr.employee_detail(f.principal.clone(), f.employee)
            .await
            .unwrap();
    assert!(
        detail
            .warnings
            .iter()
            .all(|w| w.code != "pay_below_minimum_wage")
    );
}
