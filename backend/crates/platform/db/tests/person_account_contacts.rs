// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use sqlx::PgPool;
use uuid::Uuid;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

async fn tenant(pool: &PgPool) -> Uuid {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Account contact')")
        .bind(org)
        .bind(org.to_string())
        .execute(pool)
        .await
        .unwrap();
    org
}

async fn employee(pool: &PgPool, org: Uuid, key: &str) -> Uuid {
    sqlx::query_scalar("INSERT INTO employees(org_id,company,name,birth_date,source_filename,source_sheet,source_row,source_key) VALUES($1,'Co','Worker','1990-01-01','test','test',1,$2) RETURNING id")
        .bind(org).bind(key).fetch_one(pool).await.unwrap()
}

async fn profile(pool: &PgPool, org: Uuid, employee: Uuid, actor: Uuid, phone: Option<&str>) {
    sqlx::query("INSERT INTO employee_employment_profiles(org_id,employee_id,employment_type,phone_e164,idempotency_key,request_hash,created_by) VALUES($1,$2,'REGULAR',$3,$2::text,repeat('a',64),$4)")
        .bind(org).bind(employee).bind(phone).bind(actor).execute(pool).await.unwrap();
}

#[sqlx::test(migrations = false)]
async fn shared_person_phone_across_tenants_migrates_without_replacing_account_contacts(
    pool: PgPool,
) {
    MIGRATOR.run_to(20261021103700000, &pool).await.unwrap();
    let mut accounts = Vec::new();
    // The same human works in two group companies; a third record has no human phone.
    for (i, human_phone) in [Some("+82212345678"), Some("+82212345678"), None]
        .into_iter()
        .enumerate()
    {
        let org = tenant(&pool).await;
        let employee = employee(&pool, org, "legacy").await;
        let phone = format!("+82101111000{i}");
        let account: Uuid = sqlx::query_scalar("INSERT INTO users(org_id,employee_id,display_name,phone) VALUES($1,$2,'Account',$3) RETURNING id")
            .bind(org).bind(employee).bind(&phone).fetch_one(&pool).await.unwrap();
        profile(&pool, org, employee, account, human_phone).await;
        accounts.push((account, phone));
    }
    MIGRATOR.run(&pool).await.unwrap();
    MIGRATOR.run(&pool).await.unwrap();
    for (account, expected) in accounts {
        let actual: Option<String> = sqlx::query_scalar("SELECT phone FROM users WHERE id=$1")
            .bind(account)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(actual.as_deref(), Some(expected.as_str()));
    }
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn linking_an_account_preserves_its_contact_with_or_without_a_person_phone(pool: PgPool) {
    let org = tenant(&pool).await;
    for (i, human_phone) in [None, Some("+82212345678")].into_iter().enumerate() {
        let employee = employee(&pool, org, &format!("link-{i}")).await;
        let phone = format!("+82102222000{i}");
        let account: Uuid = sqlx::query_scalar(
            "INSERT INTO users(org_id,display_name,phone) VALUES($1,'Account',$2) RETURNING id",
        )
        .bind(org)
        .bind(&phone)
        .fetch_one(&pool)
        .await
        .unwrap();
        profile(&pool, org, employee, account, human_phone).await;
        sqlx::query("UPDATE users SET employee_id=$1 WHERE id=$2")
            .bind(employee)
            .bind(account)
            .execute(&pool)
            .await
            .unwrap();
        let linked: (Uuid, String, Option<String>) =
            sqlx::query_as("SELECT person_id,display_name,phone FROM users WHERE id=$1")
                .bind(account)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(linked, (employee, "Worker".into(), Some(phone)));
    }
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn colleagues_can_edit_a_shared_office_phone_even_when_an_account_uses_it(pool: PgPool) {
    let org = tenant(&pool).await;
    let contact_owner: Uuid = sqlx::query_scalar("INSERT INTO users(org_id,display_name,phone) VALUES($1,'Office','+82212345678') RETURNING id")
        .bind(org).fetch_one(&pool).await.unwrap();
    for i in 0..2 {
        let employee = employee(&pool, org, &format!("colleague-{i}")).await;
        let phone = format!("+82103333000{i}");
        let account: Uuid = sqlx::query_scalar("INSERT INTO users(org_id,employee_id,display_name,phone) VALUES($1,$2,'Account',$3) RETURNING id")
            .bind(org).bind(employee).bind(&phone).fetch_one(&pool).await.unwrap();
        profile(&pool, org, employee, contact_owner, None).await;
        sqlx::query("UPDATE employee_employment_profiles SET phone_e164='+82212345678' WHERE employee_id=$1")
            .bind(employee).execute(&pool).await.unwrap();
        let facts: serde_json::Value = sqlx::query_scalar("SELECT console_employee_facts($1,$2)")
            .bind(org)
            .bind(employee)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(facts["phone"], "+82212345678");
        let actual: Option<String> = sqlx::query_scalar("SELECT phone FROM users WHERE id=$1")
            .bind(account)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(actual, Some(phone));
    }
}
