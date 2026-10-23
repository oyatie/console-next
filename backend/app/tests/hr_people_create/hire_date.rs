use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn employee_create_records_hire_date_and_contract_window(pool: PgPool) {
    let keys = keys();
    let org = OrgId::one();
    let user = UserId::new();
    seed_user(&pool, org, user).await;
    let branch = seed_branch(&pool, org, "People hire-date branch").await;
    let service = build_router(
        app_state(
            runtime_role_pool(&pool).await,
            leave_command_role_pool(&pool).await,
            &keys,
        )
        .unwrap(),
    );
    let token = bearer(&pool, &keys, org, user, &["SUPER_ADMIN"]).await;

    // hire_date is required; a future one registers 입사 예정 (BW-19).
    let mut missing = create_body(
        branch,
        "HIRE-001",
        "hire-key-missing",
        "010-1234-5678",
        "Hire",
    );
    missing.as_object_mut().unwrap().remove("hire_date");
    let refused = post(service.clone(), EMPLOYEES_PATH, &token, missing).await;
    assert_eq!(
        refused.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        refused.json
    );
    assert_eq!(refused.json["error"]["message"], "hire_date is required");
    let mut future = create_body(
        branch,
        "HIRE-001",
        "hire-key-future",
        "010-1234-5678",
        "Hire",
    );
    future["hire_date"] = json!("2999-01-01");
    let pre_hire = post(service.clone(), EMPLOYEES_PATH, &token, future).await;
    assert_eq!(pre_hire.status, StatusCode::CREATED, "{:?}", pre_hire.json);
    assert_eq!(pre_hire.json["employee"]["status"], "PRE_HIRE");

    // Missing contract dates remain pending; malformed supplied dates are refused.
    let mut contract = create_body(
        branch,
        "HIRE-002",
        "hire-key-contract",
        "010-1234-5679",
        "Contract",
    );
    contract["employment_type"] = json!("CONTRACT");
    let mut pending = contract.clone();
    pending["employee_number"] = json!("HIRE-PENDING");
    pending["idempotency_key"] = json!("hire-key-pending");
    pending["name"] = json!("Pending contract");
    pending["phone"] = json!("010-1234-5666");
    let incomplete = post(service.clone(), EMPLOYEES_PATH, &token, pending).await;
    assert_eq!(
        incomplete.status,
        StatusCode::CREATED,
        "{:?}",
        incomplete.json
    );
    assert_eq!(
        incomplete.json["employee"]["register_review_required"],
        true
    );
    assert!(incomplete.json["employment"]["contract_end_date"].is_null());
    let mut invalid = contract.clone();
    invalid["contract_end_date"] = json!("2026-03-01");
    let refused = post(service.clone(), EMPLOYEES_PATH, &token, invalid).await;
    assert_eq!(
        refused.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        refused.json
    );
    assert_eq!(
        refused.json["error"]["message"],
        "contract_end_date must be on or after contract_start_date"
    );
    let mut regular = create_body(
        branch,
        "HIRE-003",
        "hire-key-regular",
        "010-1234-5670",
        "Regular",
    );
    regular["contract_end_date"] = json!("2027-03-01");
    let refused = post(service.clone(), EMPLOYEES_PATH, &token, regular).await;
    assert_eq!(
        refused.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        refused.json
    );
    contract["contract_end_date"] = json!("2027-03-01");
    let created = post(service.clone(), EMPLOYEES_PATH, &token, contract).await;
    assert_eq!(created.status, StatusCode::CREATED, "{:?}", created.json);
    assert_eq!(created.json["employee"]["hire_date"], "2026-03-02");
    assert_eq!(created.json["employee"]["contract_end_date"], "2027-03-01");
    assert_eq!(
        created.json["employment"]["contract_start_date"],
        "2026-03-02"
    );
    assert_eq!(
        created.json["employment"]["contract_end_date"],
        "2027-03-01"
    );
    let events: Vec<&str> = created.json["allowed_events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|event| event["event_type"].as_str().unwrap())
        .collect();
    assert!(events.contains(&"CONTRACT_RENEWAL"), "{events:?}");
    let employee_id = Uuid::parse_str(created.json["employee"]["id"].as_str().unwrap()).unwrap();
    let onboard: String = sqlx::query_scalar(
        "SELECT effective_date FROM employee_lifecycle_events \
         WHERE org_id = $1 AND employee_id = $2 AND event_type = 'ONBOARD'",
    )
    .bind(*org.as_uuid())
    .bind(employee_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        onboard, "2026-03-02",
        "ONBOARD takes effect on the hire date"
    );

    // The contract-expiry queue reads the list filter.
    let expiring = get(
        service.clone(),
        &format!("{EMPLOYEES_PATH}?contract_ending_before=2027-03-02&status=ACTIVE"),
        &token,
    )
    .await;
    assert_eq!(expiring.status, StatusCode::OK, "{:?}", expiring.json);
    assert_eq!(expiring.json["total"], 1);
    let later = get(
        service,
        &format!("{EMPLOYEES_PATH}?contract_ending_before=2027-03-01"),
        &token,
    )
    .await;
    assert_eq!(later.json["total"], 0, "strictly before: {:?}", later.json);
}
