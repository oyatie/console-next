// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_hr_adapter_postgres::{HrService, statutory::FilingQuery};
use console_kernel_core::BranchScope;
use console_platform_authz::{Principal, Role};
use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use time::macros::datetime;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn new_future_event_gets_its_rule_version(pool: PgPool) {
    let org = OrgId::new();
    let user = seed_org_and_super_admin(&pool, *org.as_uuid(), "scheduled hire").await;
    let principal = Principal::new(user, org, [Role::SuperAdmin].into(), BranchScope::All);
    let runtime = runtime_role_pool(&pool).await;
    let hr = HrService::new(runtime.clone());
    let as_of = datetime!(2026-01-10 12:00 UTC);
    let cached = get(&runtime, &Register::default(), org).await.unwrap();
    let employee: uuid::Uuid = sqlx::query_scalar("INSERT INTO employees(org_id,company,name,employee_number,employment_status,source_filename,source_sheet,source_row,source_key) VALUES ($1,'Test','Scheduled hire','E-1','ACTIVE','roster.xlsx','Sheet',1,'scheduled') RETURNING id")
        .bind(org.as_uuid()).fetch_one(&pool).await.unwrap();
    let event = sqlx::query_scalar("INSERT INTO employee_lifecycle_events(org_id,employee_id,event_type,to_status,effective_date,comment,created_by,state,created_at) VALUES ($1,$2,'ONBOARD','ACTIVE','2099-01-01','scheduled hire',$3,'SCHEDULED',$4) RETURNING id")
        .bind(org.as_uuid()).bind(employee).bind(user.as_uuid())
        .bind(as_of - time::Duration::seconds(1)).fetch_one(&pool).await.unwrap();
    let query = FilingQuery {
        event_id: Some(event),
        insurer: Some("NPS".into()),
        kind: Some("ACQUIRE".into()),
        inbox_as_of: Some(as_of),
        ..Default::default()
    };
    let full = console_compliance_adapter_postgres::PgComplianceStore::new(runtime)
        .statutory_register()
        .await
        .unwrap();
    let assessed = hr
        .insurance_filings(principal.clone(), query.clone(), full)
        .await
        .unwrap();
    let expected = assessed.items[0].due_date.as_ref().unwrap();
    let (page, _) = hr
        .insurance_inbox_page(principal, query, cached, None)
        .await
        .unwrap();
    assert_eq!(page.items[0].due_date.as_ref(), Some(expected));
}
