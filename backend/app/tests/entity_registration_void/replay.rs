// SPDX-License-Identifier: LicenseRef-Proprietary

/// idempotent replay: voiding an unattached registration in SETUP succeeds
/// with 204; the platform replays a command without a stored result as 409 command_applied.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn void_registration_in_setup_succeeds_and_replays_idempotently(pool: PgPool) {
    let (org, owner) = tenant(&pool, ADMIN).await;
    let admin = ctx(&pool, org, owner, ADMIN, None).await;
    let reg = create_unattached_registration(&admin, "000-81-00010").await;
    let reg_uuid = Uuid::parse_str(&reg).unwrap();

    let uri = format!("/api/v1/business-registrations/{reg}/void");
    let body = json!({ "reason_code": "MISTAKE" });

    // First call voids the registration
    let (status, first) = admin.call("POST", &uri, Some(body.clone())).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{first}");

    let (is_voided, reason): (bool, Option<String>) = sqlx::query_as(
        "SELECT voided_at IS NOT NULL, void_reason_code FROM business_registrations WHERE id = $1",
    )
    .bind(reg_uuid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(is_voided, "registration must be voided");
    assert_eq!(reason.as_deref(), Some("MISTAKE"));
    assert_eq!(
        support::audits(&pool, org, "business_registration.void").await,
        1
    );
    let business = refusals::business_state(&pool, org).await;

    let audits = refusals::audit_rows(&pool, org).await;
    let commands = support::count(&pool, "command_outcomes", org).await;
    let (status, retry) = admin.retry("POST", &uri, Some(body)).await;
    assert_eq!(refusals::business_state(&pool, org).await, business);
    assert_eq!(
        (
            status,
            refusals::audit_rows(&pool, org).await,
            support::count(&pool, "command_outcomes", org).await
        ),
        (StatusCode::CONFLICT, audits + 1, commands),
        "replay must add only the platform replay audit: {retry}"
    );
    assert_eq!(code(&retry), "command_applied");
    let command_id: Uuid = sqlx::query_scalar(
        "SELECT id FROM command_outcomes WHERE org_id = $1 AND idempotency_key = $2",
    )
    .bind(org)
    .bind(admin.key.get().to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(retry["error"]["operation_id"], command_id.to_string());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn void_registration_rejects_reused_key_and_fresh_void_without_a_second_write(pool: PgPool) {
    let (org, owner) = tenant(&pool, ADMIN).await;
    let admin = ctx(&pool, org, owner, ADMIN, None).await;
    let reg = create_unattached_registration(&admin, "000-81-00010").await;
    let uri = format!("/api/v1/business-registrations/{reg}/void");
    let (status, first) = admin
        .call("POST", &uri, Some(json!({"reason_code": "MISTAKE"})))
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{first}");
    let business = refusals::business_state(&pool, org).await;
    let audits = refusals::audit_rows(&pool, org).await;
    let commands = support::count(&pool, "command_outcomes", org).await;
    let outcomes: Value = sqlx::query_scalar(
        "SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM command_outcomes r WHERE org_id = $1",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .unwrap();
    for _ in 0..2 {
        let (status, mismatch) = admin
            .retry("POST", &uri, Some(json!({"reason_code": "DUPLICATE"})))
            .await;
        assert_eq!(status, StatusCode::CONFLICT, "{mismatch}");
        assert_eq!(code(&mismatch), "idempotency_key_reused");
    }
    assert_eq!(refusals::business_state(&pool, org).await, business);
    assert_eq!(
        support::count(&pool, "command_outcomes", org).await,
        commands
    );
    let after: Value = sqlx::query_scalar(
        "SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM command_outcomes r WHERE org_id = $1",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(after, outcomes);
    assert_eq!(refusals::audit_rows(&pool, org).await, audits + 2);
    assert_eq!(
        support::audits(&pool, org, "business_registration.void").await,
        1
    );
    refused(
        &pool,
        &admin,
        "POST",
        &uri,
        Some(json!({"reason_code": "MISTAKE"})),
        StatusCode::NOT_FOUND,
        "registration_not_found",
    )
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn void_registration_rejects_invalid_reasons_and_missing_key(pool: PgPool) {
    let (org, owner) = tenant(&pool, ADMIN).await;
    let admin = ctx(&pool, org, owner, ADMIN, None).await;
    let reg = create_unattached_registration(&admin, "000-81-00010").await;
    let uri = format!("/api/v1/business-registrations/{reg}/void");
    for (body, want) in [
        (json!({}), "required"),
        (json!({"reason_code": "  "}), "required"),
        (json!({"reason_code": "CREATE"}), "reason_code_reserved"),
        (json!({"reason_code": "x".repeat(101)}), "too_long"),
    ] {
        let refusal = refused(
            &pool,
            &admin,
            "POST",
            &uri,
            Some(body),
            StatusCode::UNPROCESSABLE_ENTITY,
            want,
        )
        .await;
        assert!(
            refusals::field_codes(&refusal).contains(&("reason_code".into(), want.into())),
            "{refusal}"
        );
    }
    let business = refusals::business_state(&pool, org).await;
    let audits = refusals::audit_rows(&pool, org).await;
    let commands = support::count(&pool, "command_outcomes", org).await;
    for attempt in 1..=2 {
        let (status, missing) = admin
            .send("POST", &uri, Some(json!({"reason_code": "MISTAKE"})), None)
            .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{missing}");
        assert!(
            refusals::field_codes(&missing)
                .contains(&("Idempotency-Key".into(), "required".into())),
            "{missing}"
        );
        assert_eq!(refusals::business_state(&pool, org).await, business);
        assert_eq!(
            support::count(&pool, "command_outcomes", org).await,
            commands + attempt
        );
        assert_eq!(refusals::audit_rows(&pool, org).await, audits + 2 * attempt);
    }
}
