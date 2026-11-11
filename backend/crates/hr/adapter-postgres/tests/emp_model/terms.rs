// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::fixture::{contract, fixture};
use console_hr_domain::contract::ContractKind;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn correcting_dated_terms_keeps_the_effective_date_and_schedule(pool: PgPool) {
    let f = fixture(pool, true).await;
    let original: Uuid = sqlx::query_scalar("INSERT INTO employee_contracts(org_id,employee_id,created_by,command_id,kind,start_date,wage_won,pay_unit,weekly_minutes,daily_minutes,scheduled_days_per_week,weekly_paid_minutes,terms_effective_from) VALUES($1,$2,$3,gen_random_uuid(),'OPEN_ENDED','2026-01-01',3000000,'MONTHLY',2400,480,5,480,'2026-03-01') RETURNING id")
        .bind(*f.principal.org_id.as_uuid()).bind(f.employee).bind(*f.principal.user_id.as_uuid())
        .fetch_one(&f.owner).await.unwrap();
    let mut correction = contract(ContractKind::OpenEnded, "2026-01-01", None);
    correction.supersedes_id = Some(original);
    let key = Uuid::new_v4();
    let (fixed, _) =
        f.hr.record_contract(f.principal.clone(), f.employee, key, correction.clone())
            .await
            .unwrap();
    let stored: (Option<time::Date>, Option<i32>, Option<i32>, Option<i32>) = sqlx::query_as("SELECT terms_effective_from,daily_minutes,scheduled_days_per_week,weekly_paid_minutes FROM employee_contracts WHERE id=$1")
        .bind(fixed.id).fetch_one(&f.owner).await.unwrap();
    assert_eq!(
        stored,
        (
            Some(time::macros::date!(2026 - 03 - 01)),
            Some(480),
            Some(5),
            Some(480)
        )
    );
    let (replay, created) =
        f.hr.record_contract(f.principal.clone(), f.employee, key, correction.clone())
            .await
            .unwrap();
    assert!(!created);
    assert_eq!(replay.id, fixed.id);
    correction.supersedes_id = Some(fixed.id);
    correction.start_date = "2026-04-01".into();
    let error =
        f.hr.record_contract(f.principal.clone(), f.employee, Uuid::new_v4(), correction)
            .await
            .unwrap_err();
    assert_eq!(error.code, "contract_terms_effective_date_invalid");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn terms_port_loads_only_the_requested_employee_and_tenant(pool: PgPool) {
    use console_hr_adapter_postgres::HrError;
    use console_hr_adapter_postgres::contract::ContractRows;
    use console_hr_application::contract::{ContractRowsPort, employee_terms_on};
    use console_hr_domain::contract::monthly_standard_hours;
    use console_platform_db::with_org_conn;
    use time::macros::date;

    let f = fixture(pool, true).await;
    let org = *f.principal.org_id.as_uuid();
    let second: Uuid = sqlx::query_scalar("INSERT INTO employees(org_id,company,name,source_filename,source_sheet,source_row,source_key) VALUES($1,'회사','다른 직원','console','console',2,$2) RETURNING id")
        .bind(org).bind(Uuid::new_v4().to_string()).fetch_one(&f.owner).await.unwrap();
    let other = fixture(f.owner.clone(), true).await;
    for (tenant, employee, actor, wage) in [
        (
            org,
            f.employee,
            *f.principal.user_id.as_uuid(),
            3_000_000_i64,
        ),
        (org, second, *f.principal.user_id.as_uuid(), 4_000_000),
        (
            *other.principal.org_id.as_uuid(),
            other.employee,
            *other.principal.user_id.as_uuid(),
            5_000_000,
        ),
    ] {
        sqlx::query("INSERT INTO employee_contracts(org_id,employee_id,created_by,command_id,kind,start_date,wage_won,pay_unit,weekly_minutes,daily_minutes,scheduled_days_per_week,weekly_paid_minutes) VALUES($1,$2,$3,gen_random_uuid(),'OPEN_ENDED','2026-01-01',$4,'MONTHLY',2400,480,5,480)")
            .bind(tenant).bind(employee).bind(actor).bind(wage).execute(&f.owner).await.unwrap();
    }
    let employee = f.employee;
    let other_org = *other.principal.org_id.as_uuid();
    let foreign = other.employee;
    with_org_conn::<_, _, HrError>(&f.owner, f.principal.org_id, move |tx| {
        Box::pin(async move {
            sqlx::query("SET LOCAL ROLE console_rt")
                .execute(tx.as_mut())
                .await?;
            let loaded = ContractRows.load_rows(tx, org, employee).await?;
            assert_eq!(
                loaded.len(),
                1,
                "another employee in the same tenant must never be loaded"
            );
            let selected =
                employee_terms_on(&ContractRows, tx, org, employee, date!(2026 - 02 - 01))
                    .await?
                    .unwrap();
            assert_eq!(selected.terms.wage_won, 3_000_000);
            assert_eq!(
                monthly_standard_hours(&selected.terms).unwrap().numerator,
                1_051_200
            );
            assert!(
                ContractRows
                    .load_rows(tx, other_org, foreign)
                    .await?
                    .is_empty()
            );
            assert!(
                ContractRows
                    .load_rows(tx, other_org, employee)
                    .await?
                    .is_empty()
            );
            Ok(())
        })
    })
    .await
    .unwrap();
}
