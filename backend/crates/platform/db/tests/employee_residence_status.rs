// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use sqlx::PgPool;
use uuid::Uuid;
static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

async fn employee(pool: &PgPool) -> (Uuid, Uuid) {
    let org: Uuid = sqlx::query_scalar(
        "INSERT INTO organizations(slug,name) VALUES($1,'체류상사') RETURNING id",
    )
    .bind(Uuid::new_v4().to_string())
    .fetch_one(pool)
    .await
    .unwrap();
    let employee: Uuid = sqlx::query_scalar("INSERT INTO employees(org_id,company,name,source_filename,source_sheet,source_row,source_key) VALUES($1,'체류상사','직원','roster.xlsx','s',1,'person') RETURNING id")
        .bind(org).fetch_one(pool).await.unwrap();
    (org, employee)
}
async fn insert(
    pool: &PgPool,
    org: Uuid,
    employee: Uuid,
    code: &str,
    start: &str,
    end: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO employee_residence_statuses(org_id,employee_id,code,valid_from,valid_to) VALUES($1,$2,$3,$4::text::date,$5::text::date)")
        .bind(org).bind(employee).bind(code).bind(start).bind(end).execute(pool).await?;
    Ok(())
}
#[sqlx::test(migrator = "MIGRATOR")]
async fn dated_rows_reject_unknown_codes_dates_overlap_and_cross_tenant_links(pool: PgPool) {
    let (org, person) = employee(&pool).await;
    insert(&pool, org, person, "E-7", "2026-11-12", Some("2027-11-12"))
        .await
        .unwrap();
    for (code, start, end, state) in [
        ("Z-1", "2028-01-01", None, "23503"),
        ("E-7", "2028-01-01", Some("2028-01-01"), "23514"),
        ("E-7", "2028-01-02", Some("2028-01-01"), "23514"),
        ("F-5", "2027-11-11", None, "23P01"),
        ("F-5", "2026-11-11", Some("2026-11-13"), "23P01"),
    ] {
        let error = insert(&pool, org, person, code, start, end)
            .await
            .unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some(state)
        );
    }
    insert(&pool, org, person, "F-5", "2027-11-12", None)
        .await
        .unwrap();
    let (other, _) = employee(&pool).await;
    let error = insert(&pool, other, person, "E-7", "2028-01-01", None)
        .await
        .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("23503")
    );
    let error = sqlx::query("DELETE FROM employees WHERE id=$1")
        .bind(person)
        .execute(&pool)
        .await
        .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("23001")
    );
}
#[sqlx::test(migrator = "MIGRATOR")]
async fn storage_is_tenant_isolated_and_unavailable_to_runtime_until_cedar_api_exists(
    pool: PgPool,
) {
    let (org, person) = employee(&pool).await;
    insert(&pool, org, person, "E-7", "2026-11-12", None)
        .await
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE console_rt")
        .execute(tx.as_mut())
        .await
        .unwrap();
    assert_eq!(
        sqlx::query("SELECT * FROM employee_residence_statuses")
            .fetch_all(tx.as_mut())
            .await
            .unwrap_err()
            .as_database_error()
            .unwrap()
            .code()
            .as_deref(),
        Some("42501")
    );
    tx.rollback().await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    // Test the RLS boundary independently of the intentionally absent runtime grant.
    sqlx::query("GRANT SELECT ON employee_residence_statuses TO console_rt")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("SET LOCAL ROLE console_rt")
        .execute(tx.as_mut())
        .await
        .unwrap();
    for (tenant, count) in [(org, 1_i64), (Uuid::new_v4(), 0)] {
        sqlx::query("SELECT set_config('app.current_org',$1,true)")
            .bind(tenant.to_string())
            .execute(tx.as_mut())
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM employee_residence_statuses")
                .fetch_one(tx.as_mut())
                .await
                .unwrap(),
            count
        );
    }
    tx.rollback().await.unwrap();
}
