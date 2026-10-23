// SPDX-License-Identifier: LicenseRef-Proprietary

/// 403: voiding a business registration without legal_entity:manage is refused
/// and writes nothing; another tenant's manager gets 404 with no business writes.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn void_registration_without_permission_is_forbidden_and_writes_nothing(pool: PgPool) {
    let (org, owner) = tenant(&pool, ADMIN).await;
    let admin = ctx(&pool, org, owner, ADMIN, None).await;
    let (entity, ..) = structure(&admin).await;
    let reg = registration_of(&pool, &entity).await;

    for roles in [&["ADMIN"][..], &["MEMBER"][..]] {
        let user = add_user(&pool, org, roles).await;
        let member_ctx = ctx(&pool, org, user, roles, None).await;
        refused(
            &pool,
            &member_ctx,
            "POST",
            &format!("/api/v1/business-registrations/{reg}/void"),
            Some(json!({ "reason_code": "MISTAKE" })),
            StatusCode::FORBIDDEN,
            "forbidden",
        )
        .await;
    }

    let business = refusals::business_state(&pool, org).await;
    let audits = refusals::audit_rows(&pool, org).await;
    let (other_org, other_owner) = tenant(&pool, ADMIN).await;
    let other = ctx(&pool, other_org, other_owner, ADMIN, None).await;
    refused(
        &pool,
        &other,
        "POST",
        &format!("/api/v1/business-registrations/{reg}/void"),
        Some(json!({ "reason_code": "MISTAKE" })),
        StatusCode::NOT_FOUND,
        "registration_not_found",
    )
    .await;
    assert_eq!(refusals::business_state(&pool, org).await, business);
    assert_eq!(refusals::audit_rows(&pool, org).await, audits);

    let is_voided: bool = sqlx::query_scalar(
        "SELECT voided_at IS NOT NULL FROM business_registrations WHERE id = $1",
    )
    .bind(Uuid::parse_str(&reg).unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        !is_voided,
        "registration must remain un-voided after 403 refusal"
    );
}

/// A branch-scoped manager cannot void its registration's 법인-level record.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn void_registration_outside_the_managers_scope_is_forbidden(pool: PgPool) {
    let (org, owner) = tenant(&pool, ADMIN).await;
    let admin = ctx(&pool, org, owner, ADMIN, None).await;
    let (entity, workplace, branch, _) = structure(&admin).await;
    let reg = registration_of(&pool, &entity).await;
    let roles = &["EXECUTIVE"];
    let user = add_user(&pool, org, roles).await;
    let keys = support::keys();
    let issuer = JwtIssuer::from_es256_pem(
        JwtSettings {
            issuer: "console-platform-auth".into(),
            audience: "console-api".into(),
            access_token_ttl: time::Duration::minutes(15),
        },
        keys.0.as_bytes(),
        keys.1.as_bytes(),
    )
    .unwrap();
    let token = console_platform_test_support::issue_session_token(
        &pool,
        &issuer,
        AccessTokenInput {
            subject: user,
            org_id: OrgId::from_uuid(org),
            roles: roles.iter().map(|r| (*r).to_owned()).collect(),
            branches: Vec::new(),
            display_name: None,
            feature_grants: Vec::new(),
            platform: false,
            view_as: false,
            read_only: false,
            authz_subject_version: 0,
            authz_policy_version: 0,
            session_generation: 0,
            issued_at: time::OffsetDateTime::now_utc(),
        },
        Some(AccessScope::new(
            AccessScopeLevel::Branch,
            ScopeNodeId::from_uuid(Uuid::parse_str(&branch).unwrap()),
        )),
        vec![],
    )
    .await;
    let manager = support::Ctx {
        service: console_app::build_router(support::app_state(
            support::role_pool(&pool, "console_rt", None).await,
            support::role_pool(&pool, "console_leave_cmd", None).await,
            &keys,
        )),
        token,
        org,
        user,
        key: std::cell::Cell::new(Uuid::nil()),
    };
    refused(
        &pool,
        &manager,
        "POST",
        &format!("/api/v1/business-registrations/{reg}/void"),
        Some(json!({ "reason_code": "MISTAKE" })),
        StatusCode::FORBIDDEN,
        "forbidden",
    )
    .await;

    let (status, body) = manager
        .call(
            "POST",
            &format!("/api/v1/workplaces/{workplace}/void"),
            Some(json!({ "reason_code": "MISTAKE" })),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "grant works in scope: {body}"
    );
}
