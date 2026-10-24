// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use sqlx::PgPool;
use uuid::Uuid;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[sqlx::test(migrator = "MIGRATOR")]
async fn redirected_facts_keep_their_existing_database_validation(pool: PgPool) {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Fact validation')")
        .bind(org)
        .bind(org.to_string())
        .execute(&pool)
        .await
        .unwrap();
    let employee: Uuid = sqlx::query_scalar("INSERT INTO employees(org_id,company,name,source_filename,source_sheet,source_row,source_key) VALUES($1,'Co','Valid','test','test',1,'valid') RETURNING id")
        .bind(org).fetch_one(&pool).await.unwrap();
    let account: Uuid = sqlx::query_scalar(
        "INSERT INTO users(org_id,employee_id,display_name) VALUES($1,$2,'Valid') RETURNING id",
    )
    .bind(org)
    .bind(employee)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO employee_employment_profiles(org_id,employee_id,employment_type,phone_e164,idempotency_key,request_hash,created_by) VALUES($1,$2,'REGULAR','+821012341234','valid',repeat('a',64),$3)")
        .bind(org).bind(employee).bind(account).execute(&pool).await.unwrap();
    for (sql, id, code) in [
        (
            "UPDATE users SET display_name=NULL WHERE id=$1",
            account,
            "23502",
        ),
        (
            "UPDATE employees SET name=NULL WHERE id=$1",
            employee,
            "23502",
        ),
        (
            "UPDATE employee_employment_profiles SET phone_e164='invalid' WHERE employee_id=$1",
            employee,
            "23514",
        ),
    ] {
        let error = sqlx::query(sql).bind(id).execute(&pool).await.unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some(code)
        );
    }
    let current: (String, String) =
        sqlx::query_as("SELECT display_name,phone FROM person_accounts_current WHERE id=$1")
            .bind(account)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(current, ("Valid".into(), "+821012341234".into()));
}
