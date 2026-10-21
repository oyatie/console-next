//! PA-DATE expand step: the DATE pair mirrors the TEXT pair both ways, an
//! unparsable text stays undated, and the readers serve the DATE.

use sqlx::PgPool;
use time::macros::date;
use uuid::Uuid;

use crate::fixture::fixture;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_strict_parser_never_guesses(pool: PgPool) {
    for (text, parsed) in [
        (Some("2026-09-01"), Some(date!(2026 - 09 - 01))),
        (Some(" 2024-02-29 "), Some(date!(2024 - 02 - 29))),
        (Some("2025-02-29"), None),
        (Some("2026.09.01"), None),
        (Some("2026-9-1"), None),
        (Some("45123"), None),
        (None, None),
    ] {
        let got: Option<time::Date> = sqlx::query_scalar("SELECT public.employees_iso_date($1)")
            .bind(text)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(got, parsed, "{text:?}");
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_text_and_date_pairs_stay_in_step(pool: PgPool) {
    let f = fixture(pool.clone()).await;
    let org = *f.principal.org_id.as_uuid();
    let insert = |hire: &'static str| {
        let pool = pool.clone();
        async move {
            sqlx::query_scalar::<_, Uuid>(
                "INSERT INTO employees (org_id, company, name, source_filename, source_sheet, source_row, source_key, hire_date) \
                 VALUES ($1, 'Co', 'x', 'console', 'console', 1, $2, $3) RETURNING id",
            )
            .bind(org)
            .bind(Uuid::new_v4().to_string())
            .bind(hire)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    let pair = |id: Uuid| {
        let pool = pool.clone();
        async move {
            sqlx::query_as::<
                _,
                (
                    Option<String>,
                    Option<time::Date>,
                    Option<String>,
                    Option<time::Date>,
                ),
            >(
                "SELECT hire_date, hire_on, exit_date, exit_on FROM employees WHERE id = $1"
            )
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };

    // A text writer (the 0166 import apply) fills the date; garbage stays undated.
    let typed = insert("2026-09-01").await;
    assert_eq!(pair(typed).await.1, Some(date!(2026 - 09 - 01)));
    let legacy = insert("2026.09.01").await;
    assert_eq!(
        pair(legacy).await,
        (Some("2026.09.01".into()), None, None, None)
    );

    // A date writer fills the text.
    sqlx::query("UPDATE employees SET exit_on = DATE '2027-01-31' WHERE id = $1")
        .bind(typed)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(pair(typed).await.2.as_deref(), Some("2027-01-31"));
    // A text update re-dates; clearing either side clears both.
    sqlx::query("UPDATE employees SET hire_date = '2026-08-01', exit_on = NULL WHERE id = $1")
        .bind(typed)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        pair(typed).await,
        (
            Some("2026-08-01".into()),
            Some(date!(2026 - 08 - 01)),
            None,
            None
        )
    );
    // Both sides naming different days is refused.
    let error = sqlx::query(
        "UPDATE employees SET hire_date = '2026-08-02', hire_on = DATE '2026-08-03' WHERE id = $1",
    )
    .bind(typed)
    .execute(&pool)
    .await
    .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("23514")
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn registration_writes_the_date_and_readers_serve_it(pool: PgPool) {
    let f = fixture(pool.clone()).await;
    let mut body = f.body("dated", "REGULAR");
    body.base_pay = "2500000".into();
    let detail = f.create(body).await.unwrap();
    assert_eq!(detail.employee.hire_date.as_deref(), Some("2026-09-01"));
    let (text, on): (Option<String>, Option<time::Date>) =
        sqlx::query_as("SELECT hire_date, hire_on FROM employees WHERE id = $1")
            .bind(detail.employee.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        (text.as_deref(), on),
        (Some("2026-09-01"), Some(date!(2026 - 09 - 01)))
    );

    // A legacy undated text is not served as a date.
    sqlx::query("UPDATE employees SET hire_date = '2026.09.01' WHERE id = $1")
        .bind(detail.employee.id)
        .execute(&pool)
        .await
        .unwrap();
    let facts =
        f.hr.employment_facts(f.principal.clone(), detail.employee.id)
            .await
            .unwrap();
    assert_eq!(facts.hire_date, None);
}
