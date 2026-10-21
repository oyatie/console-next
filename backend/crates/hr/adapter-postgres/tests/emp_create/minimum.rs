use console_hr_adapter_postgres::directory::read_list::EmployeeListQuery;
use console_hr_adapter_postgres::directory::types::CreateEmployeeRequest;
use sqlx::PgPool;

use super::fixture::fixture;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn name_and_hire_date_register_unplaced_with_unknown_facts_and_followups(pool: PgPool) {
    let f = fixture(pool.clone()).await;
    let body: CreateEmployeeRequest = serde_json::from_value(serde_json::json!({
        "name": "최최소", "hire_date": "2026-09-01", "idempotency_key": "minimum"
    }))
    .unwrap();
    let detail = f.create(body).await.unwrap();
    let wire = serde_json::to_value(&detail).unwrap();
    assert!(wire["employment"].is_null());
    assert!(wire["pending_employment"]["employment_type"].is_null());
    let employee = &detail.employee;
    assert_eq!(employee.name, "최최소");
    assert_eq!(employee.hire_date.as_deref(), Some("2026-09-01"));
    assert!(employee.org_unit_id.is_none());
    assert!(employee.workplace_id.is_none());
    assert!(employee.home_branch_id.is_none());
    assert!(employee.register_review_required);
    let port = console_ontology_canonical_adapter_postgres::employment::PgEmploymentPort::new(
        f.rt.clone(),
        tokio::runtime::Handle::current(),
    );
    let org = f.principal.org_id;
    let id = employee.id;
    let current =
        tokio::task::spawn_blocking(move || port.read_current_effective_for_employee(org, id))
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    assert!(current.is_active);
    assert_eq!(current.company.as_deref(), Some(""));
    let profile = detail.employment.unwrap();
    assert!(profile.employment_type.is_none());
    assert!(profile.phone_e164.is_none());
    assert!(profile.base_pay.is_none());
    let facts =
        f.hr.employment_facts(f.principal.clone(), employee.id)
            .await
            .unwrap();
    let profile = facts.employment.unwrap();
    assert!(profile.employment_type.is_none());
    assert!(profile.worker_classification.is_none());
    let query = EmployeeListQuery {
        register_review_required: Some(true),
        ..Default::default()
    };
    let list =
        f.hr.list_employees(f.principal.clone(), query)
            .await
            .unwrap();
    assert!(list.items.iter().any(|row| row.id == employee.id));
    let facets =
        f.hr.employee_facets(f.principal.clone(), Default::default())
            .await
            .unwrap();
    assert_eq!(facets.review.register_review_required, 1);
    // Database checks still reject bad supplied facts after the expansion.
    for sql in [
        "UPDATE employee_employment_profiles SET employment_type = 'INVALID' WHERE employee_id = $1",
        "UPDATE employee_employment_profiles SET phone_e164 = 'invalid' WHERE employee_id = $1",
        "UPDATE employee_employment_profiles SET base_pay = -1 WHERE employee_id = $1",
    ] {
        assert!(
            sqlx::query(sql)
                .bind(employee.id)
                .execute(&pool)
                .await
                .is_err()
        );
    }
    f.hr.patch_employment_facts(
        f.principal.clone(),
        id,
        serde_json::from_value(serde_json::json!([
            {"op": "test", "path": "/birth_date", "value": null},
            {"op": "replace", "path": "/birth_date", "value": "1994-03-02"}
        ]))
        .unwrap(),
    )
    .await
    .unwrap();
    let updated: time::OffsetDateTime =
        sqlx::query_scalar("SELECT updated_at FROM employees WHERE id = $1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    let body = serde_json::from_value(serde_json::json!({
        "expected_updated_at": updated.format(&time::format_description::well_known::Rfc3339).unwrap(),
        "reason_code": "DATA_ENTRY_ERROR",
        "changes": {
            "sex": "MALE", "job": "생산",
            "address": {"source": "MANUAL_UNVERIFIED", "road_addr_part1": "서울특별시 강남구 테헤란로 1", "si_nm": "서울특별시", "sgg_nm": "강남구"},
            "careers": []
        }
    })).unwrap();
    f.hr.correct_employee(
        f.principal.clone(),
        &console_platform_test_support::soft_passkey::passkey_service(),
        id,
        body,
        console_hr_adapter_postgres::corrections::SecondPersonContext {
            other_eligible_holders: 1,
            routed: true,
            sole_holder_refuse: false,
        },
    )
    .await
    .unwrap();
    let list =
        f.hr.list_employees(
            f.principal.clone(),
            EmployeeListQuery {
                register_review_required: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(
        list.items.is_empty(),
        "recorded statutory facts leave the follow-up queue"
    );
    let facets =
        f.hr.employee_facets(f.principal.clone(), Default::default())
            .await
            .unwrap();
    assert_eq!(facets.review.register_review_required, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unclassified_facts_expand_the_wire_contract_and_remain_redacted_for_readers(pool: PgPool) {
    let f = fixture(pool).await;
    let body = serde_json::from_value(serde_json::json!({
        "name": "최미분류", "hire_date": "2026-09-01", "idempotency_key": "pending",
        "phone": "010-1234-5678", "base_pay_won": 3_000_000, "pay_unit": "MONTHLY"
    }))
    .unwrap();
    let detail = f.create(body).await.unwrap();
    let wire = serde_json::to_value(&detail).unwrap();
    assert!(
        wire["employment"].is_null(),
        "N-1 clients never receive a null classification"
    );
    assert_eq!(wire["pending_employment"]["phone_e164"], "+821012345678");
    assert_eq!(wire["pending_employment"]["base_pay"], "3000000.00");
    let facts =
        f.hr.employment_facts(f.principal.clone(), detail.employee.id)
            .await
            .unwrap();
    let wire = serde_json::to_value(&facts).unwrap();
    assert!(wire["employment"].is_null());
    assert_eq!(wire["pending_employment"]["base_pay_won"], 3_000_000);
    assert!(wire["pending_employment"]["worker_classification"].is_null());
    let reader = serde_json::to_value(detail.redact_for_reader()).unwrap();
    assert!(reader["employment"].is_null());
    let pending = &reader["pending_employment"];
    assert!(pending.get("phone_e164").is_none());
    assert!(pending.get("base_pay").is_none());
}

#[test]
fn missing_optional_facts_do_not_allow_invalid_supplied_values() {
    use console_hr_adapter_postgres::directory::normalize::normalize_create_employee_request;
    for bad in [
        serde_json::json!({"name": ""}),
        serde_json::json!({"phone": "010-bad"}),
        serde_json::json!({"employment_type": "INVALID"}),
        serde_json::json!({"base_pay": "-1"}),
        serde_json::json!({"birth_date": "1990-13-01"}),
    ] {
        let mut json = serde_json::json!({"name": "최최소", "hire_date": "2026-09-01", "idempotency_key": "bad"});
        json.as_object_mut()
            .unwrap()
            .extend(bad.as_object().unwrap().clone());
        // An out-of-contract enum (`employment_type`) is refused at deserialization by the wire
        // validator; every other bad value reaches the domain's normalization and is refused there.
        let refused = serde_json::from_value(json).map_or(true, |body| {
            normalize_create_employee_request(body).is_err()
        });
        assert!(refused, "{bad}");
    }
}
