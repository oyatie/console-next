//! Shared fixtures of the LC-B1 / LC-B3 migration tests (0313, 0314): SQL
//! rows for trigger and CHECK proofs. The zero-loss migration test seeds
//! through the API instead (app/tests/lifecycle_foundation_migration.rs).
#![allow(dead_code)]

use sqlx::PgPool;
use uuid::Uuid;

pub struct Tenant {
    pub org: Uuid,
    pub user: Uuid,
}

pub async fn tenant(pool: &PgPool) -> Tenant {
    let (org, user) = (Uuid::new_v4(), Uuid::new_v4());
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'LC-B1')")
        .bind(org)
        .bind(format!("lcb1-{}", &org.simple().to_string()[..12]))
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, 'HR', '{SUPER_ADMIN}', $2)")
        .bind(user)
        .bind(org)
        .execute(pool)
        .await
        .unwrap();
    Tenant { org, user }
}

pub async fn person(pool: &PgPool, t: &Tenant, key: &str) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO employees (org_id, company, name, source_filename, source_sheet, source_row, source_key, hire_date) \
         VALUES ($1, 'A', $2, 'console', 's', 1, $2, '2024-01-02') RETURNING id",
    )
    .bind(t.org)
    .bind(key)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// A filled head: `[hire, exit]`, valid_to aligned when closed.
pub async fn head(
    pool: &PgPool,
    t: &Tenant,
    employee: Uuid,
    hire: &str,
    exit: Option<&str>,
) -> Result<Uuid, sqlx::Error> {
    sqlx::query_scalar(
        "INSERT INTO employment_heads (org_id, valid_from, valid_to, employee_id, hire_date, exit_date, cause, continuity) \
         VALUES ($1, ($3::date)::timestamp AT TIME ZONE 'Asia/Seoul', \
                 (($4::date) + 1)::timestamp AT TIME ZONE 'Asia/Seoul', $2, $3::date, $4::date, 'HIRE', 'NEW') \
         RETURNING id",
    )
    .bind(t.org)
    .bind(employee)
    .bind(hire)
    .bind(exit)
    .fetch_one(pool)
    .await
}

pub async fn exec(pool: &PgPool, sql: &'static str, id: Uuid) -> Result<u64, String> {
    sqlx::query(sql)
        .bind(id)
        .execute(pool)
        .await
        .map(|r| r.rows_affected())
        .map_err(|e| e.to_string())
}

pub fn refused(result: Result<u64, String>, code: &str) {
    let error = result.expect_err("refused");
    assert!(error.contains(code), "{error}");
}

pub struct Case {
    pub org: Uuid,
    pub hr: Uuid,
    /// The account of the person the case is about.
    pub subject_user: Uuid,
    pub employee: Uuid,
    pub case: Uuid,
}

/// A tenant, its HR user, one employee with an account, and an exit case
/// dated `exit` in `status`, backfilled into a lifecycle case.
pub async fn case(pool: &PgPool, exit: &str, status: &str) -> Case {
    let (org, hr, subject_user) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'LC-B3')")
        .bind(org)
        .bind(format!("lcb3-{}", &org.simple().to_string()[..12]))
        .execute(pool)
        .await
        .unwrap();
    let employee: Uuid = sqlx::query_scalar(
        "INSERT INTO employees (org_id, company, name, source_filename, source_sheet, source_row, source_key, hire_date) \
         VALUES ($1, 'A', '퇴직자', 'console', 's', 1, 'k', '2020-01-02') RETURNING id",
    )
    .bind(org)
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, org_id, employee_id) VALUES \
         ($1, 'HR', '{SUPER_ADMIN}', $3, NULL), ($2, '본인', '{MEMBER}', $3, $4)",
    )
    .bind(hr)
    .bind(subject_user)
    .bind(org)
    .bind(employee)
    .execute(pool)
    .await
    .unwrap();
    let case: Uuid = sqlx::query_scalar(
        "INSERT INTO employee_exit_cases (org_id, employee_id, status, effective_exit_date, site_manager_note, \
             reported_by, exit_reason_code, closed_at, closed_reason) \
         VALUES ($1, $2, $3, $4::date, 'n', $5, 'DISCIPLINARY_DISMISSAL', \
                 CASE WHEN $3 IN ('CANCELLED', 'REJECTED') THEN now() END, \
                 CASE WHEN $3 IN ('CANCELLED', 'REJECTED') THEN 'withdrawn' END) RETURNING id",
    )
    .bind(org)
    .bind(employee)
    .bind(status)
    .bind(exit)
    .bind(hr)
    .fetch_one(pool)
    .await
    .unwrap();
    let written: i64 = sqlx::query_scalar("SELECT lifecycle_backfill_exit_cases($1)")
        .bind(org)
        .fetch_one(pool)
        .await
        .unwrap();
    assert!(written >= 1);
    Case {
        org,
        hr,
        subject_user,
        employee,
        case,
    }
}

pub fn live_exit() -> String {
    (time::OffsetDateTime::now_utc().date() + time::Duration::days(10)).to_string()
}

/// Runs `sql` with `$1` = org, `$2` = case and the `extra` ids as `$3`, `$4`, ...
pub async fn run(
    pool: &PgPool,
    sql: &'static str,
    c: &Case,
    extra: &[Uuid],
) -> Result<u64, String> {
    let mut query = sqlx::query(sql).bind(c.org).bind(c.case);
    for id in extra {
        query = query.bind(*id);
    }
    query
        .execute(pool)
        .await
        .map(|r| r.rows_affected())
        .map_err(|e| e.to_string())
}
