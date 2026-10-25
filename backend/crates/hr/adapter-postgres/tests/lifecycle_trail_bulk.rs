// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! The scale proof creates its people through the product service before one bulk action.

#[allow(dead_code)]
#[path = "emp_create/fixture.rs"]
mod fixture;

use std::sync::Arc;
use std::time::Instant;

use console_hr_adapter_postgres::clock::today_kst;
use console_inbox_adapter_postgres::PgInboxStore;
use console_leave_adapter_postgres::PgLeaveStore;
use serde_json::json;
use sqlx::PgPool;
use time::Duration;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn two_thousand_product_hires_open_two_thousand_cases_in_one_bulk_appointment(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let people = 2_000;
    let mut employees = Vec::with_capacity(people);
    for n in 0..people {
        let mut body = f.body(&format!("lifecycle-scale-{n}"), "REGULAR");
        body.name = format!("합성 직원 {n}");
        body.employee_number = format!("TRAIL-{n}");
        body.hire_date = Some((today_kst() - Duration::days(1)).to_string());
        body.home_branch_id = None;
        let store = PgLeaveStore::new(f.rt.clone(), Arc::new(PgInboxStore::new(f.rt.clone())));
        let (_, employee) =
            f.hr.create_employee(f.principal.clone(), store, body)
                .await
                .unwrap();
        employees.push(employee.employee_id());
    }
    let started = Instant::now();
    let (job, _) =
        f.hr.accept_bulk_lifecycle_job(
            &f.principal,
            Uuid::new_v4().to_string(),
            json!({"event_type":"APPOINT","to_job":"개발","effective_date":today_kst().to_string(),
            "comment":"합성 직원 일괄 발령","selection":{"query":{},"expected_count":people}}),
        )
        .await
        .unwrap();
    f.hr.drive_bulk_lifecycle_job(f.principal.clone(), job.id)
        .await;
    let (state, result, error): (String, Option<serde_json::Value>, Option<serde_json::Value>) =
        sqlx::query_as(
            "SELECT state,result,error FROM employee_lifecycle_bulk_jobs WHERE org_id=$1 AND id=$2",
        )
        .bind(f.principal.org_id.as_uuid())
        .bind(job.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        state, "done",
        "the product bulk budget refused the batch: {error:?}"
    );
    let result = result.unwrap();
    println!(
        "bulk appointment of {people} product-created employees: {:?}",
        started.elapsed()
    );
    assert_eq!(result["items"].as_array().unwrap().len(), people);
    let batch = Uuid::parse_str(result["batch_id"].as_str().unwrap()).unwrap();
    let (events,cases,subjects):(i64,i64,i64)=sqlx::query_as(
        "SELECT count(DISTINCT l.id),count(DISTINCT c.id),count(DISTINCT c.employee_id) \
         FROM employee_lifecycle_events l LEFT JOIN lifecycle_cases c ON c.org_id=l.org_id AND c.trigger_id=l.id \
         WHERE l.org_id=$1 AND l.batch_id=$2")
        .bind(f.principal.org_id.as_uuid()).bind(batch).fetch_one(&pool).await.unwrap();
    let expected = i64::try_from(people).unwrap();
    assert_eq!((events, cases, subjects), (expected, expected, expected));
    let hires:i64=sqlx::query_scalar("SELECT count(*) FROM lifecycle_cases WHERE org_id=$1 AND kind='HIRE' AND employee_id=ANY($2)")
        .bind(f.principal.org_id.as_uuid()).bind(&employees).fetch_one(&pool).await.unwrap();
    assert_eq!(hires, expected);
    let observed: i64 = sqlx::query_scalar("SELECT count(*) FROM lifecycle_cases c \
        JOIN employee_lifecycle_events l ON l.org_id=c.org_id AND l.id=c.trigger_id \
        JOIN lifecycle_case_items i ON i.org_id=c.org_id AND i.case_id=c.id \
        WHERE l.org_id=$1 AND l.batch_id=$2 AND i.item_key='R1' AND i.status='DONE_OBSERVED' \
          AND i.observed_ref->>'table'='employee_lifecycle_events' AND i.observed_ref->>'id'=l.id::text")
        .bind(f.principal.org_id.as_uuid()).bind(batch).fetch_one(&pool).await.unwrap();
    assert_eq!(
        observed, expected,
        "each case observes its actual event in the bulk transaction"
    );
}
