// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_hr_adapter_postgres::statutory::FilingQuery;
use time::macros::datetime;

#[path = "../../../crates/hr/adapter-postgres/tests/emp_create/fixture.rs"]
mod registration;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn new_future_event_gets_its_rule_version(pool: PgPool) {
    let f = registration::fixture(pool.clone()).await;
    let as_of = datetime!(2026-01-10 12:00 UTC);
    let cached = get(&f.rt, &Register::default(), f.principal.org_id)
        .await
        .unwrap();
    let employee = f
        .create(f.body("scheduled", "REGULAR"))
        .await
        .unwrap()
        .employee
        .id;
    let event = sqlx::query_scalar("INSERT INTO employee_lifecycle_events(org_id,employee_id,event_type,to_status,effective_date,comment,created_by,state,created_at) VALUES ($1,$2,'ONBOARD','ACTIVE','2099-01-01','scheduled hire',$3,'SCHEDULED',$4) RETURNING id")
        .bind(f.principal.org_id.as_uuid()).bind(employee).bind(f.principal.user_id.as_uuid())
        .bind(as_of - time::Duration::seconds(1)).fetch_one(&pool).await.unwrap();
    let query = FilingQuery {
        event_id: Some(event),
        insurer: Some("NPS".into()),
        kind: Some("ACQUIRE".into()),
        inbox_as_of: Some(as_of),
        ..Default::default()
    };
    let full = console_compliance_adapter_postgres::PgComplianceStore::new(f.rt.clone())
        .statutory_register()
        .await
        .unwrap();
    let assessed =
        f.hr.insurance_filings(f.principal.clone(), query.clone(), full)
            .await
            .unwrap();
    let expected = assessed.items[0].due_date.as_ref().unwrap();
    let (page, _) =
        f.hr.insurance_inbox_page(f.principal, query, cached, None)
            .await
            .unwrap();
    assert_eq!(page.items[0].due_date.as_ref(), Some(expected));
}
