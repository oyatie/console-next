// SPDX-License-Identifier: LicenseRef-Proprietary

/// phase_not_setup: voiding after go-live (OPERATING phase) is refused with
/// phase_not_setup, naming close_record_instead, and writes nothing.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn void_registration_refuses_with_phase_not_setup_after_go_live(pool: PgPool) {
    let (org, owner) = tenant(&pool, ADMIN).await;
    let admin = ctx(&pool, org, owner, ADMIN, None).await;
    let mut passkey = SoftKey::enroll(&pool, OrgId::from_uuid(org), owner).await;
    let (entity, _, branch, unit) = structure(&admin).await;
    let reg = registration_of(&pool, &entity).await;
    let (status, department) = admin
        .call(
            "POST",
            "/api/v1/org-structure/units",
            Some(json!({ "name": "인사팀", "parent_org_unit_id": unit })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{department}");
    let (status, person) = admin
        .call(
            "POST",
            "/api/v1/employees",
            Some(support::employee_body("E-1", &branch, &unit)),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{person}");
    let (status, preview) = admin
        .call("GET", "/api/v1/onboarding/go-live/preview", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["blockers"], json!([]), "{preview}");
    let step_up = passkey.step_up(&pool).await;
    let (status, live) = admin.call(
        "POST", "/api/v1/onboarding/go-live",
        Some(json!({ "digest": preview["digest"], "step_up": step_up, "sole_holder_acknowledged": true })),
    ).await;
    assert_eq!(status, StatusCode::OK, "{live}");
    assert_eq!(live["phase"], "OPERATING");

    let refusal = refused(
        &pool,
        &admin,
        "POST",
        &format!("/api/v1/business-registrations/{reg}/void"),
        Some(json!({ "reason_code": "MISTAKE" })),
        StatusCode::CONFLICT,
        "phase_not_setup",
    )
    .await;
    assert_eq!(refusal["error"]["reasons"], json!(["close_record_instead"]));

    let is_voided: bool = sqlx::query_scalar(
        "SELECT voided_at IS NOT NULL FROM business_registrations WHERE id = $1",
    )
    .bind(Uuid::parse_str(&reg).unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        !is_voided,
        "registration must remain un-voided after phase_not_setup refusal"
    );
}

/// record_in_use: voiding a registration that has workplaces filing under it
/// is refused with 409 record_in_use (remedy: move_workplaces_first).
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn void_registration_refuses_with_record_in_use_when_workplaces_file_under_it(pool: PgPool) {
    let (org, owner) = tenant(&pool, ADMIN).await;
    let admin = ctx(&pool, org, owner, ADMIN, None).await;
    let (entity, workplace, ..) = structure(&admin).await;
    let reg = registration_of(&pool, &entity).await;

    let refusal = refused(
        &pool,
        &admin,
        "POST",
        &format!("/api/v1/business-registrations/{reg}/void"),
        Some(json!({ "reason_code": "MISTAKE" })),
        StatusCode::CONFLICT,
        "record_in_use",
    )
    .await;
    assert_eq!(
        refusal["error"]["reasons"],
        json!(["move_workplaces_first"])
    );

    let is_voided: bool = sqlx::query_scalar(
        "SELECT voided_at IS NOT NULL FROM business_registrations WHERE id = $1",
    )
    .bind(Uuid::parse_str(&reg).unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        !is_voided,
        "registration must remain un-voided after record_in_use refusal"
    );

    sqlx::query("UPDATE workplaces SET closed_on = '2020-03-03' WHERE id = $1")
        .bind(Uuid::parse_str(&workplace).unwrap())
        .execute(&pool)
        .await
        .unwrap();
    refused(
        &pool,
        &admin,
        "POST",
        &format!("/api/v1/business-registrations/{reg}/void"),
        Some(json!({ "reason_code": "MISTAKE" })),
        StatusCode::CONFLICT,
        "record_in_use",
    )
    .await;

    let (status, body) = admin
        .call(
            "POST",
            &format!("/api/v1/workplaces/{workplace}/void"),
            Some(json!({ "reason_code": "MISTAKE" })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    let (status, body) = admin
        .call(
            "POST",
            &format!("/api/v1/business-registrations/{reg}/void"),
            Some(json!({ "reason_code": "MISTAKE" })),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "voided workplace no longer blocks: {body}"
    );
    let is_voided: bool = sqlx::query_scalar(
        "SELECT voided_at IS NOT NULL FROM business_registrations WHERE id = $1",
    )
    .bind(Uuid::parse_str(&reg).unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(is_voided);
}
