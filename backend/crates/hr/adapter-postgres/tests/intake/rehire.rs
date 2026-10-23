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
                    request.base_pay_won = Some(2_500_000);
                    request
                })
                .await
                .unwrap();
        assert_eq!(replayed, expected_replay);
        assert_eq!(detail.employee.id, id);
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
async fn a_former_employee_without_a_profile_can_rehire_before_pay_is_recorded(pool: PgPool) {
    let f = fixture(pool.clone()).await;
    let id = exited(&f, &pool, "unpaid-1").await;
    sqlx::query("DELETE FROM employee_employment_profiles WHERE employee_id=$1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    let (_, detail) =
        f.hr.rehire_employee(f.principal.clone(), id, rehire(&f, "unpaid-2", kst_day(0)))
            .await
            .unwrap();
    assert_eq!(detail.employee.id, id);
    assert!(detail.employment.unwrap().base_pay.is_none());
}
