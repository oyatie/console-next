use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn tenant_request_is_own_scoped_and_lower_grants_are_refused(owner: PgPool) {
    let h = Harness::new(owner).await;
    let org_id = h.onboard("request-api").await;
    let tenant_user: uuid::Uuid =
        sqlx::query_scalar("SELECT id FROM users WHERE org_id=$1 LIMIT 1")
            .bind(org_id)
            .fetch_one(&h.owner)
            .await
            .unwrap();
    let token = h
        .token_for(
            console_kernel_core::UserId::from_uuid(tenant_user),
            OrgId::from_uuid(org_id),
            false,
            vec!["SUPER_ADMIN".into()],
        )
        .await;
    let path = console_platform_rest::TENANT_DOMAIN_REQUEST_PATH;
    for slug in ["ab", "request-api"] {
        let (status, body) = h.send_as("POST", path, json!({"slug":slug}), &token).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(body["error"]["code"], "slug_invalid");
    }
    let (status, body) = h
        .send_as("POST", path, json!({"slug":"requested-api"}), &token)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (_, state) = h.send_as("GET", path, Value::Null, &token).await;
    assert_eq!(state["pending_domain"], "requested-api");
    let member =
        console_platform_test_support::seed_active_user(&h.owner, org_id, "MEMBER", "HR").await;
    let limited = h
        .token_for(
            member,
            OrgId::from_uuid(org_id),
            false,
            vec!["MEMBER".into()],
        )
        .await;
    for method in ["GET", "POST"] {
        let (status, body) = h
            .send_as(method, path, json!({"slug":"not-applied"}), &limited)
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert_eq!(body["error"]["code"], "forbidden");
    }
    let (slug, count): (String, i64) = h.read("SELECT slug,(SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='tenant.domain.request') FROM organization_domain_requests WHERE org_id=$1", org_id).await;
    assert_eq!((slug, count), ("requested-api".into(), 1));

    let other_id = h.onboard("other-company").await;
    let other_user: uuid::Uuid = sqlx::query_scalar("SELECT id FROM users WHERE org_id=$1 LIMIT 1")
        .bind(other_id)
        .fetch_one(&h.owner)
        .await
        .unwrap();
    let other_token = h
        .token_for(
            console_kernel_core::UserId::from_uuid(other_user),
            OrgId::from_uuid(other_id),
            false,
            vec!["SUPER_ADMIN".into()],
        )
        .await;
    let (status, own) = h.send_as("GET", path, Value::Null, &other_token).await;
    assert_eq!(status, StatusCode::OK, "{own}");
    assert!(
        own["pending_domain"].is_null(),
        "another tenant cannot see the request"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn domain_wire_keys_refuse_invalid_requests_without_partial_changes(owner: PgPool) {
    let h = Harness::new(owner).await;
    let org = h.onboard("key-contract").await;
    let user: uuid::Uuid = sqlx::query_scalar("SELECT id FROM users WHERE org_id=$1 LIMIT 1")
        .bind(org)
        .fetch_one(&h.owner)
        .await
        .unwrap();
    let token = h
        .token_for(
            console_kernel_core::UserId::from_uuid(user),
            OrgId::from_uuid(org),
            false,
            vec!["SUPER_ADMIN".into()],
        )
        .await;
    let path = console_platform_rest::TENANT_DOMAIN_REQUEST_PATH;
    for (key, code) in [
        (None, "validation"),
        (Some("short"), "invalid_request_key"),
        (Some(""), "invalid_request_key"),
    ] {
        let (status, refused) = h
            .send_as_with_key("POST", path, json!({"slug":"valid-request"}), &token, key)
            .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{refused}");
        assert_eq!(refused["error"]["code"], code);
    }
    let uri = format!("{PLATFORM_ORGS_PATH}/{org}");
    for (key, body) in [
        ("short", json!({"name":"Ignored"})),
        (
            "domain-valid-key-01",
            json!({"status":"SUSPENDED", "name":"Ignored"}),
        ),
    ] {
        let (status, refused) = h.send_with_key("PATCH", &uri, body, Some(key)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{refused}");
        assert_eq!(refused["error"]["code"], "validation");
    }
    assert_eq!(
        h.org(org).await,
        (
            "key-contract".into(),
            "Tenant key-contract".into(),
            "ACTIVE".into()
        )
    );
    let (pending, audits): (i64, i64) = h.read("SELECT (SELECT count(*) FROM organization_domain_requests WHERE org_id=$1), (SELECT count(*) FROM audit_events WHERE org_id=$1 AND action IN ('tenant.domain.request', 'platform.tenant.rename', 'platform.tenant.status'))", org).await;
    assert_eq!((pending, audits), (0, 0));
}
