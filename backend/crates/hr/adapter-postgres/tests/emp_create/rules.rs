//! Pure: normalisation refusals, the request hash and the 최저임금 warning.

use console_hr_adapter_postgres::directory::create_facts::{
    CreateEmployeeContract, NormalizedEmployeeFacts, minimum_wage_warning,
};
use console_hr_adapter_postgres::directory::normalize::normalize_create_employee_request;
use console_hr_adapter_postgres::directory::types::CreateEmployeeRequest;
use console_hr_domain::profile::enums::{EmploymentType, PayUnit};
use time::macros::date;
use uuid::Uuid;

fn body(employment_type: &str) -> CreateEmployeeRequest {
    CreateEmployeeRequest {
        name: "김".into(),
        company: "Co".into(),
        employment_type: employment_type.into(),
        phone: "010-1234-5678".into(),
        org_unit_id: Some(Uuid::nil()),
        position: "사원".into(),
        site: "본사".into(),
        idempotency_key: "k-1".into(),
        hire_date: Some("2026-09-01".into()),
        base_pay: "2500000".into(),
        ..Default::default()
    }
}

fn refused(body: CreateEmployeeRequest) -> String {
    normalize_create_employee_request(body).unwrap_err().message
}

#[test]
fn facts_that_cannot_be_recorded_are_refused() {
    let contract = |kind: &str| {
        Some(CreateEmployeeContract {
            kind: kind.into(),
            weekly_minutes: Some(2400),
            ..Default::default()
        })
    };
    let cases: Vec<(CreateEmployeeRequest, &str)> = vec![
        (body("SEASONAL"), "employment_type is not a known value"),
        (
            CreateEmployeeRequest {
                contract: contract("FIXED_TERM"),
                ..body("REGULAR")
            },
            "contract.kind does not fit employment_type",
        ),
        (
            CreateEmployeeRequest {
                contract: Some(CreateEmployeeContract {
                    kind: "FREELANCE_SERVICE".into(),
                    pay_unit: Some("MONTHLY".into()),
                    ..Default::default()
                }),
                ..body("FREELANCE")
            },
            "end_date is required for FREELANCE_SERVICE",
        ),
        (
            CreateEmployeeRequest {
                probation_end_date: Some("2026-11-30".into()),
                ..body("EXECUTIVE")
            },
            "probation_end_date applies only to employees",
        ),
        (
            CreateEmployeeRequest {
                probation_end_date: Some("2026-08-31".into()),
                ..body("REGULAR")
            },
            "probation_end_date must be on or after the hire date",
        ),
        (
            CreateEmployeeRequest {
                base_pay_won: Some(1),
                ..body("REGULAR")
            },
            "base_pay_won and pay_unit are given together",
        ),
        (
            CreateEmployeeRequest {
                base_pay_won: Some(2_600_000),
                pay_unit: Some("MONTHLY".into()),
                ..body("REGULAR")
            },
            "base_pay must equal base_pay_won",
        ),
        (
            CreateEmployeeRequest {
                birth_date: Some("2099-01-01".into()),
                ..body("REGULAR")
            },
            "birth_date must be a past date on or after 1900-01-01",
        ),
        (
            CreateEmployeeRequest {
                work_email: Some("kim@corp".into()),
                ..body("REGULAR")
            },
            "work_email must be a mailbox like name@example.com",
        ),
        (
            CreateEmployeeRequest {
                id_type: Some("PASSPORT".into()),
                ..body("REGULAR")
            },
            "id_type is not a known value",
        ),
        (
            CreateEmployeeRequest {
                contract: contract("OPEN_ENDED"),
                ..body("REGULAR")
            },
            "contract.pay_unit is required",
        ),
        (
            CreateEmployeeRequest {
                contract_end_date: Some("2027-01-31".into()),
                contract: Some(CreateEmployeeContract {
                    kind: "FIXED_TERM".into(),
                    end_date: Some("2027-02-28".into()),
                    wage_won: Some(1),
                    pay_unit: Some("HOURLY".into()),
                    weekly_minutes: Some(2400),
                    ..Default::default()
                }),
                ..body("CONTRACT")
            },
            "contract_start_date and contract_end_date must match contract",
        ),
    ];
    for (request, message) in cases {
        assert_eq!(refused(request), message);
    }
}

#[test]
fn a_contract_registration_takes_its_window_from_the_first_contract() {
    let request = normalize_create_employee_request(CreateEmployeeRequest {
        base_pay: String::new(),
        base_pay_won: Some(12_000),
        pay_unit: Some("HOURLY".into()),
        contract: Some(CreateEmployeeContract {
            kind: "FIXED_TERM".into(),
            end_date: Some("2027-02-28".into()),
            weekly_minutes: Some(2400),
            ..Default::default()
        }),
        ..body("CONTRACT")
    })
    .unwrap();
    assert_eq!(request.base_pay.as_deref(), Some("12000.00"));
    assert_eq!(request.contract_start_date.as_deref(), Some("2026-09-01"));
    assert_eq!(request.contract_end_date.as_deref(), Some("2027-02-28"));
    let contract = request.facts.contract.unwrap();
    assert_eq!(
        (contract.wage_won, contract.pay_unit),
        (12_000, PayUnit::Hourly)
    );
}

#[test]
fn a_request_without_facts_hashes_as_before() {
    let request = normalize_create_employee_request(body("REGULAR")).unwrap();
    let json = serde_json::to_value(&request).unwrap();
    let mut keys: Vec<&str> = json
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "base_pay",
            "company",
            "employee_number",
            "employment_type",
            "hire_date",
            "home_branch_id",
            "idempotency_key",
            "name",
            "org_unit",
            "org_unit_id",
            "phone_e164",
            "position",
            "site"
        ]
    );
}

#[test]
fn pay_below_the_minimum_wage_warns_only_for_employees() {
    let hourly = |won| NormalizedEmployeeFacts {
        base_pay_won: Some(won),
        pay_unit: Some(PayUnit::Hourly),
        ..Default::default()
    };
    let on = Some(date!(2026 - 09 - 01));
    let warning = minimum_wage_warning(EmploymentType::PartTime, &hourly(10_000), on).unwrap();
    assert_eq!(
        (warning.code, warning.floor_won),
        ("pay_below_minimum_wage", Some(10_320))
    );
    assert!(minimum_wage_warning(EmploymentType::PartTime, &hourly(10_320), on).is_none());
    assert!(minimum_wage_warning(EmploymentType::Freelance, &hourly(1), on).is_none());
    assert!(
        minimum_wage_warning(
            EmploymentType::Regular,
            &NormalizedEmployeeFacts::default(),
            on
        )
        .is_none()
    );
    // No 고시 recorded for the year: silent, never a guessed floor.
    assert!(
        minimum_wage_warning(
            EmploymentType::Regular,
            &hourly(1),
            Some(date!(2031 - 01 - 01))
        )
        .is_none()
    );
}
