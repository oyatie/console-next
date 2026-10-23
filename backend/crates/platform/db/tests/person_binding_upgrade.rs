// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrations = false)]
async fn existing_two_thousand_accounts_and_employees_upgrade_without_unbound_rows(pool: PgPool) {
    let migrator = sqlx::migrate!("./migrations");
    migrator.run_to(20261021103700000, &pool).await.unwrap();
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Legacy people')")
        .bind(org)
        .bind(org.to_string())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO employees(org_id,company,name,employee_number,birth_date,source_filename,source_sheet,source_row,source_key) SELECT $1,'Co','Worker '||n,'P-'||n,'1990-01-01','legacy','legacy',n,'legacy-'||n FROM generate_series(1,2000) n")
        .bind(org).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO users(org_id,employee_id,display_name) SELECT org_id,id,name FROM employees WHERE org_id=$1")
        .bind(org).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO users(org_id,display_name) VALUES($1,'Worker 1')")
        .bind(org)
        .execute(&pool)
        .await
        .unwrap();
    migrator.run(&pool).await.unwrap();
    migrator.run(&pool).await.unwrap();
    let missing: i64 = sqlx::query_scalar("SELECT count(*) FROM employees e LEFT JOIN employee_person_bindings b ON b.org_id=e.org_id AND b.employee_id=e.id JOIN users u ON u.org_id=e.org_id AND u.employee_id=e.id WHERE e.org_id=$1 AND (b.person_id IS NULL OR u.person_id IS DISTINCT FROM b.person_id)")
        .bind(org).fetch_one(&pool).await.unwrap();
    assert_eq!(missing, 0);
    let accounts: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE org_id=$1 AND person_id IS NULL AND principal_kind='TENANT_PERSON'")
        .bind(org).fetch_one(&pool).await.unwrap();
    assert_eq!(accounts, 0);
    let reviews: i64 = sqlx::query_scalar("SELECT count(*) FROM person_binding_reviews WHERE org_id=$1 AND subject_kind='ACCOUNT' AND reason='EMPLOYEE_LINK_MISSING'")
        .bind(org).fetch_one(&pool).await.unwrap();
    assert_eq!(
        reviews, 1,
        "matching names are evidence for review, never a merge key"
    );
    let validated: bool = sqlx::query_scalar(
        "SELECT convalidated FROM pg_constraint WHERE conname='users_principal_person_check'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(validated);
}
