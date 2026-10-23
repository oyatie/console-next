// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[path = "emp_create/fixture.rs"]
mod fixture;

use console_hr_adapter_postgres::record::CreateRecordRequest;
use console_hr_domain::record::Section;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn person_fact_edits_reach_employee_and_invited_account(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let employee = f.create(f.body("facts", "REGULAR")).await.unwrap().employee;
    let person: Uuid =
        sqlx::query_scalar("SELECT person_id FROM employee_person_bindings WHERE employee_id=$1")
            .bind(employee.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    let account: Uuid = sqlx::query_scalar("INSERT INTO users(org_id,employee_id,display_name) VALUES($1,$2,'Old invite') RETURNING id")
        .bind(f.principal.org_id.as_uuid()).bind(employee.id).fetch_one(&pool).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(f.principal.org_id.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("SELECT console_revise_person_facts($1,$2,$3,$4)")
        .bind(f.principal.org_id.as_uuid())
        .bind(person)
        .bind(json!({"legal_name":"김새이름","phone":"+821099991234"}))
        .bind(f.principal.user_id.as_uuid())
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let detail =
        f.hr.employee_detail(f.principal.clone(), employee.id)
            .await
            .unwrap();
    assert_eq!(detail.employee.name, "김새이름");
    assert_eq!(
        detail.employment.unwrap().phone_e164.as_deref(),
        Some("+821099991234")
    );
    let current: (Uuid, String, String) = sqlx::query_as(
        "SELECT person_id,display_name,phone FROM person_accounts_current WHERE id=$1",
    )
    .bind(account)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(current.0, person);
    assert_eq!(
        (current.1.as_str(), current.2.as_str()),
        ("김새이름", "+821099991234")
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn record_write_refuses_missing_binding_without_creating_a_person(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let employee = f
        .create(f.body("missing", "REGULAR"))
        .await
        .unwrap()
        .employee;
    sqlx::query("DELETE FROM employee_person_bindings WHERE employee_id=$1")
        .bind(employee.id)
        .execute(&pool)
        .await
        .unwrap();
    let refused = f.hr.create_record(f.principal.clone(),employee.id,Section::Education,Uuid::new_v4(),CreateRecordRequest {
        fields: json!({"school":"한국대학교","level":"BACHELOR","major":"경영학","status":"GRADUATED","entered_on":"2010-03-02","ended_on":"2014-02-20"}),
    }).await.unwrap_err();
    assert_eq!(refused.code, "person_binding_required");
    let bindings: i64 =
        sqlx::query_scalar("SELECT count(*) FROM employee_person_bindings WHERE employee_id=$1")
            .bind(employee.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(bindings, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn erasure_clears_person_and_frozen_employee_account_snapshots(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let detail = f.create(f.body("erase", "REGULAR")).await.unwrap();
    let employee = detail.employee;
    let account: Uuid = sqlx::query_scalar("INSERT INTO users(org_id,employee_id,display_name) VALUES($1,$2,'Original account') RETURNING id")
        .bind(f.principal.org_id.as_uuid()).bind(employee.id).fetch_one(&pool).await.unwrap();
    f.hr.setup_delete_employee(
        f.principal.clone(),
        employee.id,
        console_hr_adapter_postgres::registration_void::SetupDeleteRequest {
            expected_updated_at: employee
                .updated_at
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap(),
            reason_code: "DUPLICATE_ENTRY".into(),
            register_kept: false,
        },
    )
    .await
    .unwrap();
    let raw: (String,Option<time::Date>,Option<String>) = sqlx::query_as("SELECT e.name,e.birth_date,p.phone_e164 FROM employees e JOIN employee_employment_profiles p ON p.employee_id=e.id WHERE e.id=$1")
        .bind(employee.id).fetch_one(&pool).await.unwrap();
    assert_eq!(raw, ("(파기됨)".into(), None, None));
    let current: (String, Option<String>) =
        sqlx::query_as("SELECT display_name,phone FROM person_accounts_current WHERE id=$1")
            .bind(account)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(current, ("(파기됨)".into(), None));
    let legacy: (String, Option<String>) =
        sqlx::query_as("SELECT display_name,phone FROM users WHERE id=$1")
            .bind(account)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(legacy, current);
}
