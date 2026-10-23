//! BW-19 2: 재입사 is the same person on a new employment period.

use console_hr_adapter_postgres::directory::create_rehire_input::RehireEmployeeRequest;
use sqlx::PgPool;

use crate::fixture::{Fixture, fixture};
use crate::{kst_day, register};

fn rehire(f: &Fixture, key: &str, hire_date: String) -> RehireEmployeeRequest {
    RehireEmployeeRequest {
        hire_date,
        employment_type: "CONTRACT".into(),
        org_unit_id: f.unit,
        position: "대리".into(),
        company: None,
        contract_end_date: Some(kst_day(400)),
        phone: None,
        base_pay_won: None,
        pay_unit: None,
        idempotency_key: key.into(),
    }
}

async fn exited(f: &Fixture, pool: &PgPool, key: &str) -> uuid::Uuid {
    let mut body = f.body(key, "REGULAR");
    body.name = format!("재입사 {key}");
    let (created, _) = register(f, body).await.unwrap();
    sqlx::query("UPDATE employees SET employment_status = 'EXITED', exit_date = $2 WHERE id = $1")
        .bind(created.employee.id)
        .bind(kst_day(-10))
        .execute(pool)
        .await
        .unwrap();
    created.employee.id
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_former_employee_comes_back_as_the_same_person(pool: PgPool) {
    let f = fixture(pool.clone()).await;
    let id = exited(&f, &pool, "re-1").await;
    let (number, person): (Option<String>, uuid::Uuid) = sqlx::query_as(
        "SELECT e.employee_number, b.person_id FROM employees e \
         JOIN employee_person_bindings b ON b.employee_id = e.id AND b.org_id = e.org_id \
         WHERE e.id = $1",
    )
    .bind(id)
    .fetch_one(&pool)
    .await
    .unwrap();

    let (replayed, detail) =
        f.hr.rehire_employee(f.principal.clone(), id, rehire(&f, "re-2", kst_day(0)))
            .await
            .unwrap();
    assert!(!replayed);
    assert_eq!(detail.employee.id, id);
    assert_eq!(detail.employee.status.as_deref(), Some("ACTIVE"));
    assert_eq!(detail.employee.employee_number, number);
    assert_eq!(
        serde_json::to_value(&detail.employee).unwrap()["person_id"],
        person.to_string()
    );
    assert_eq!(detail.employee.exit_date, None);
    assert_eq!(detail.employee.hire_date, Some(kst_day(0)));
    assert_eq!(
        detail
            .employment
            .as_ref()
            .unwrap()
            .employment_type
            .as_deref(),
        Some("CONTRACT")
    );
    let event: (String, String) = sqlx::query_as(
        "SELECT from_status, to_status FROM employee_lifecycle_events \
         WHERE employee_id = $1 AND event_type = 'REHIRE'",
    )
    .bind(id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(event, ("EXITED".into(), "ACTIVE".into()));

    let (again, _) =
        f.hr.rehire_employee(f.principal.clone(), id, rehire(&f, "re-2", kst_day(0)))
            .await
            .unwrap();
    assert!(again, "the same key and body replay");
    let after: uuid::Uuid =
        sqlx::query_scalar("SELECT person_id FROM employee_person_bindings WHERE employee_id = $1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(after, person, "rehire and its replay preserve the person");
    let refused =
        f.hr.rehire_employee(f.principal.clone(), id, rehire(&f, "re-3", kst_day(0)))
            .await
            .unwrap_err();
    assert_eq!(
        (refused.status.as_u16(), refused.code),
        (409, "rehire_requires_exited")
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_imported_former_employee_reuses_their_person(pool: PgPool) {
    let im = crate::import_fixture::importer(pool.clone()).await;
    let mut former = crate::import_fixture::line("E-RE-1", "재입사 김일");
    former.exit = Some("2025-12-31");
    im.load("퇴사자.xlsx", &[former]).await;
    let (id, ..) = im.person("E-RE-1").await;
    let person: uuid::Uuid =
        sqlx::query_scalar("SELECT person_id FROM employee_person_bindings WHERE employee_id = $1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();

    for expected_replay in [false, true] {
        let (replayed, detail) =
            im.f.hr
                .rehire_employee(im.f.principal.clone(), id, {
                    let mut request = rehire(&im.f, "import-re-1", kst_day(0));
                    request.phone = Some("010-1234-5678".into());
                    request.base_pay_won = Some(12_000);
                    request.pay_unit = Some("HOURLY".into());
                    request
                })
                .await
                .unwrap();
        assert_eq!(replayed, expected_replay);
        assert_eq!(detail.employee.id, id);
        let pay: (Option<i64>, Option<String>) = sqlx::query_as(
            "SELECT base_pay_won,pay_unit FROM employee_employment_profiles WHERE employee_id=$1",
        )
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(pay, (Some(12_000), Some("HOURLY".into())));
        assert_eq!(
            serde_json::to_value(&detail.employee).unwrap()["person_id"],
            person.to_string()
        );
        let after: uuid::Uuid = sqlx::query_scalar(
            "SELECT person_id FROM employee_person_bindings WHERE employee_id = $1",
        )
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(after, person);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_future_rehire_is_pre_hire_with_a_scheduled_onboard(pool: PgPool) {
    let f = fixture(pool.clone()).await;
    let id = exited(&f, &pool, "fr-1").await;
    let (_, detail) =
        f.hr.rehire_employee(f.principal.clone(), id, rehire(&f, "fr-2", kst_day(14)))
            .await
            .unwrap();
    assert_eq!(detail.employee.status.as_deref(), Some("PRE_HIRE"));
    let states: Vec<(String, String)> = sqlx::query_as(
        "SELECT event_type, state FROM employee_lifecycle_events \
         WHERE employee_id = $1 AND event_type IN ('REHIRE', 'ONBOARD') \
         ORDER BY created_at, event_type",
    )
    .bind(id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert!(states.contains(&("REHIRE".into(), "APPLIED".into())));
    assert!(states.contains(&("ONBOARD".into(), "SCHEDULED".into())));
    // A first day on or before the last exit is not a new period.
    let early = exited(&f, &pool, "fr-3").await;
    let refused =
        f.hr.rehire_employee(f.principal.clone(), early, rehire(&f, "fr-4", kst_day(-10)))
            .await
            .unwrap_err();
    assert_eq!(
        (refused.status.as_u16(), refused.code),
        (422, "rehire_date_not_after_exit")
    );
    assert_eq!(refused.refusals.unwrap()[0]["exit_date"], kst_day(-10));
    let head =
        f.hr.employee_detail(f.principal.clone(), early)
            .await
            .unwrap();
    assert_eq!(head.employee.status.as_deref(), Some("EXITED"));
    assert_eq!(head.employee.exit_date, Some(kst_day(-10)));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_profileless_rehire_still_requires_phone_and_base_pay(pool: PgPool) {
    let f = fixture(pool.clone()).await;
    let id = exited(&f, &pool, "unpaid-1").await;
    sqlx::query("DELETE FROM employee_employment_profiles WHERE employee_id=$1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    for (phone, pay) in [(None, Some(12_000)), (Some("010-1234-5678"), None)] {
        let mut body = rehire(&f, "missing-facts", kst_day(0));
        body.phone = phone.map(str::to_owned);
        body.base_pay_won = pay;
        body.pay_unit = Some("HOURLY".into());
        let refused =
            f.hr.rehire_employee(f.principal.clone(), id, body)
                .await
                .unwrap_err();
        assert_eq!((refused.status.as_u16(), refused.code), (422, "validation"));
        let status: String =
            sqlx::query_scalar("SELECT employment_status FROM employees WHERE id=$1")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "EXITED", "a refusal rolls back the new period");
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn released_rehire_without_pay_unit_uses_recorded_terms_or_keeps_unknown(pool: PgPool) {
    let f = fixture(pool.clone()).await;
    for recorded in [false, true] {
        let id = exited(&f, &pool, &format!("legacy-{recorded}")).await;
        sqlx::query("DELETE FROM employee_employment_profiles WHERE employee_id=$1")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        if recorded {
            sqlx::query("INSERT INTO employee_contracts(org_id,employee_id,command_id,kind,start_date,wage_won,pay_unit,created_by) VALUES($1,$2,gen_random_uuid(),'OPEN_ENDED',$3::date,12000,'HOURLY',$4)")
                .bind(f.principal.org_id.as_uuid()).bind(id).bind(kst_day(0))
                .bind(f.principal.user_id.as_uuid()).execute(&pool).await.unwrap();
        }
        let mut request = rehire(&f, &format!("released-{recorded}"), kst_day(0));
        request.phone = Some("010-1234-5678".into());
        request.base_pay_won = Some(12_000);
        for expected_replay in [false, true] {
            let (replayed, _) =
                f.hr.rehire_employee(f.principal.clone(), id, request.clone())
                    .await
                    .unwrap();
            assert_eq!(replayed, expected_replay);
            let pay: (Option<String>, Option<i64>, i64) = sqlx::query_as(
                "SELECT pay_unit,base_pay_won,base_pay::bigint FROM employee_employment_profiles WHERE employee_id=$1",
            )
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(
                pay,
                (
                    recorded.then(|| "HOURLY".into()),
                    recorded.then_some(12_000),
                    12_000
                )
            );
        }
    }
}
