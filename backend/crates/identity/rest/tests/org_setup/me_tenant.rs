// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_onboarding_adapter_postgres::PgOnboardingStore;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn me_tenant_facts_need_no_grant_and_follow_go_live(pool: PgPool) {
    let harness = Harness::new(pool.clone()).await;
    let org = OrgId::new();
    seed_org(&pool, org, "shell-facts").await;
    let owner =
        seed_user_in_org_with_team(&pool, org, "Tenant owner", &["SUPER_ADMIN"], None, None).await;
    let mut tokens = Vec::new();
    for roles in [&["ADMIN"][..], &[][..]] {
        let user =
            seed_user_in_org_with_team(&pool, org, "Tenant account", roles, None, None).await;
        if !roles.is_empty() {
            let role = uuid::Uuid::new_v4();
            let event = AuditEvent::new(
                Some(owner),
                AuditAction::new("test.grant_hr").unwrap(),
                "access_role",
                role.to_string(),
                TraceContext::generate(),
                OffsetDateTime::now_utc(),
            )
            .with_org(org);
            with_audit(&pool, event, |tx| Box::pin(async move {
                sqlx::query("INSERT INTO access_roles (org_id,id,name_ko,status,version,created_by) VALUES ($1,$2,'Test HR','ACTIVE',1,$3)")
                    .bind(org.as_uuid()).bind(role).bind(owner.as_uuid()).execute(tx.as_mut()).await?;
                sqlx::query("INSERT INTO access_role_versions (org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES ($1,$2,1,'Test HR','ACTIVE','SETUP',$3)")
                    .bind(org.as_uuid()).bind(role).bind(owner.as_uuid()).execute(tx.as_mut()).await?;
                sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) VALUES ($1,$2,1,'hr_basic',ARRAY['view','edit'])")
                    .bind(org.as_uuid()).bind(role).execute(tx.as_mut()).await?;
                sqlx::query("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by) VALUES ($1,$2,$3,'TENANT',now() - interval '1 day',true,'SETUP','TEST',$4)")
                    .bind(org.as_uuid()).bind(user.as_uuid()).bind(role).bind(owner.as_uuid()).execute(tx.as_mut()).await?;
                Ok::<(), DbError>(())
            })).await.unwrap();
        }
        let token = harness.token_for_org(org, user, roles, vec![]).await;
        let (status, body) = send(&harness, "GET", "/api/v1/users/me", &token, None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            body["tenant"],
            json!({"name": "Test Org shell-facts", "phase": "SETUP", "go_live_at": null})
        );
        tokens.push(token);
    }
    let event = AuditEvent::new(
        None,
        AuditAction::new("test.go_live").unwrap(),
        "tenant",
        org.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org);
    let at = OffsetDateTime::now_utc();
    with_audit(&pool, event, |tx| Box::pin(async move {
        sqlx::query("UPDATE tenant_phase SET phase = 'OPERATING', go_live_at = $2, go_live_by = $3, go_live_preview_digest = repeat('a', 64) WHERE org_id = $1")
            .bind(org.as_uuid()).bind(at).bind(owner.as_uuid()).execute(tx.as_mut()).await?;
        Ok::<(), DbError>(())
    })).await.unwrap();
    for token in tokens {
        let (status, body) = send(&harness, "GET", "/api/v1/users/me", &token, None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["tenant"]["phase"], "OPERATING");
        let returned = OffsetDateTime::parse(
            body["tenant"]["go_live_at"].as_str().unwrap(),
            &time::format_description::well_known::Rfc3339,
        )
        .unwrap();
        assert_eq!(returned.unix_timestamp(), at.unix_timestamp());
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn me_tenant_facts_ignore_branch_scope_without_changing_user_lists(pool: PgPool) {
    let harness = Harness::new(pool.clone()).await;
    let branch = seed_branch(&pool).await;
    let user = seed_user(&pool, "Scoped account", &["SUPER_ADMIN"], Some(branch)).await;
    let event = AuditEvent::new(
        None,
        AuditAction::new("test.legacy_operating").unwrap(),
        "tenant",
        OrgId::one().to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(OrgId::one());
    with_audit(&pool, event, |tx| {
        Box::pin(async move {
            sqlx::query("UPDATE tenant_phase SET phase = 'OPERATING' WHERE org_id = $1")
                .bind(OrgId::one().as_uuid())
                .execute(tx.as_mut())
                .await?;
            Ok::<(), DbError>(())
        })
    })
    .await
    .unwrap();
    let token = harness
        .scoped_token(
            user,
            &["SUPER_ADMIN"],
            vec![],
            AccessScope::new(
                AccessScopeLevel::Branch,
                ScopeNodeId::from_uuid(*branch.as_uuid()),
            ),
        )
        .await;
    let (status, body) = send(&harness, "GET", "/api/v1/users/me", &token, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let name: String = sqlx::query_scalar("SELECT name FROM organizations WHERE id = $1")
        .bind(OrgId::one().as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(body["tenant"]["name"], name);
    assert_eq!(body["tenant"]["phase"], "OPERATING");
    assert_eq!(body["tenant"]["go_live_at"], Value::Null);
    let (status, body) = send(&harness, "GET", "/api/v1/users", &token, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(
        body["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row.get("tenant").is_none())
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn me_tenant_facts_are_isolated_and_read_the_current_organization_name(pool: PgPool) {
    let harness = Harness::new(pool.clone()).await;
    for slug in ["shell-a", "shell-b"] {
        let org = OrgId::new();
        seed_org(&pool, org, slug).await;
        let user = seed_user_in_org_with_team(&pool, org, "No grants", &[], None, None).await;
        let token = harness.token_for_org(org, user, &[], vec![]).await;
        let (status, body) = send(&harness, "GET", "/api/v1/users/me", &token, None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["tenant"]["name"], format!("Test Org {slug}"));
        let event = AuditEvent::new(
            None,
            AuditAction::new("test.rename_org").unwrap(),
            "organization",
            org.to_string(),
            TraceContext::generate(),
            OffsetDateTime::now_utc(),
        )
        .with_org(org);
        with_audit(&pool, event, |tx| {
            Box::pin(async move {
                sqlx::query("UPDATE organizations SET name = name || ' renamed' WHERE id = $1")
                    .bind(org.as_uuid())
                    .execute(tx.as_mut())
                    .await?;
                Ok::<(), DbError>(())
            })
        })
        .await
        .unwrap();
        let (status, body) = send(&harness, "GET", "/api/v1/users/me", &token, None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["tenant"]["name"], format!("Test Org {slug} renamed"));
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn platform_me_has_no_tenant_facts(pool: PgPool) {
    let harness = Harness::new(pool.clone()).await;
    let root = sqlx::query_scalar("SELECT platform_ensure_cold_start_admin()")
        .fetch_one(&pool)
        .await
        .unwrap();
    let mut input = harness.access_token_input_for_org(
        OrgId::platform(),
        UserId::from_uuid(root),
        &["SUPER_ADMIN"],
        vec![],
    );
    input.platform = true;
    let token = console_platform_test_support::issue_session_token(
        &harness.pool,
        &harness.issuer(),
        input,
        None,
        vec![],
    )
    .await;
    let (status, body) = send(&harness, "GET", "/api/platform/users/me", &token, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.get("tenant").is_none(), "{body}");
    let (status, _) = send(&harness, "GET", "/api/v1/users/me", &token, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

impl Harness {
    pub(super) fn service(&self) -> Router {
        let verifier = JwtVerifier::from_es256_public_pem(
            JwtSettings {
                issuer: TEST_ISSUER.to_owned(),
                audience: TEST_AUDIENCE.to_owned(),
                access_token_ttl: Duration::minutes(15),
            },
            self.public_pem.as_bytes(),
        )
        .unwrap();
        router(
            IdentityRestState::new(
                PgOrgStore::new(self.pool.clone()),
                Some(verifier),
                PgOnboardingStore::new(self.pool.clone()),
            )
            .with_passkey_step_up(Some(passkey_service())),
        )
    }
}
