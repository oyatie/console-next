//! Company-domain aliases reserve identity and resolve under the runtime role.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_kernel_core::OrgId;
use console_platform_auth::current_sign_in_id;
use console_platform_provisioning::{PlatformProvisioner, ProvisioningError};
use console_platform_test_support::{
    runtime_role_pool,
    soft_passkey::{SoftKey, passkey_service},
};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rename_keeps_alias_sign_in_and_updates_all_accounts(owner: PgPool) {
    let rt = runtime_role_pool(&owner).await;
    let p = PlatformProvisioner::new(Duration::minutes(15));
    let now = OffsetDateTime::now_utc();
    let created = p
        .onboard_tenant(&rt, None, "domain-before", "Customer", now)
        .await
        .unwrap();
    let org = OrgId::from_uuid(created.organization.id);
    let user = console_kernel_core::UserId::from_uuid(created.admin_user_id);
    let mut key = SoftKey::enroll(&owner, org, user).await;
    let old_id = current_sign_in_id(&rt, org, created.admin_user_id)
        .await
        .unwrap()
        .unwrap();
    let renamed = p
        .rename_tenant(&rt, None, *org.as_uuid(), Some("domain-after"), None, now)
        .await
        .unwrap();
    assert_eq!(renamed.domain_aliases, ["domain-before"]);
    assert_eq!(
        current_sign_in_id(&rt, org, created.admin_user_id)
            .await
            .unwrap()
            .unwrap(),
        old_id.replace("@domain-before", "@domain-after")
    );
    let deadline: OffsetDateTime = sqlx::query_scalar(
        "SELECT alias_until FROM organization_domains WHERE slug = 'domain-before'",
    )
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(
        deadline,
        now + Duration::days(console_platform_auth::SIGN_IN_ALIAS_DAYS)
    );
    let ceremony = passkey_service()
        .start_identified_authentication(&rt, &old_id)
        .await
        .unwrap();
    let assertion = key
        .assert(&serde_json::to_value(&ceremony.challenge).unwrap())
        .unwrap();
    let credential = serde_json::from_value(assertion).unwrap();
    let authenticated = passkey_service()
        .finish_authentication(&rt, ceremony.ceremony_id, credential)
        .await
        .unwrap();
    assert_eq!(authenticated.user_id, created.admin_user_id);
    let (notified, audit): (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM notifications WHERE org_id=$1 AND category='tenant.domain.change'), \
                (SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='platform.tenant.rename')")
        .bind(*org.as_uuid()).fetch_one(&owner).await.unwrap();
    assert_eq!((notified, audit), (1, 1));
    // Expiration affects authentication only; search and availability retain the reservation.
    sqlx::query("UPDATE organization_domains SET retired_at = now() - interval '2 days', alias_until = now() - interval '1 day' WHERE slug='domain-before'")
        .execute(&owner).await.unwrap();
    let (resolved,): (Option<uuid::Uuid>,) =
        sqlx::query_as("SELECT user_id FROM platform_sign_in_options($1)")
            .bind(&old_id)
            .fetch_one(&rt)
            .await
            .unwrap();
    assert_eq!(resolved, None);
    assert!(matches!(
        p.onboard_tenant(&rt, None, "domain-before", "Impersonator", now)
            .await,
        Err(ProvisioningError::SlugTaken)
    ));
    assert!(matches!(
        p.rename_tenant(&rt, None, *org.as_uuid(), Some("domain-before"), None, now)
            .await,
        Err(ProvisioningError::SlugTaken)
    ));
    assert!(
        !sqlx::query_scalar::<_, bool>("SELECT platform_company_domain_available('domain-before')")
            .fetch_one(&rt)
            .await
            .unwrap()
    );
    assert_eq!(
        p.list_tenants(&rt, None, now)
            .await
            .unwrap()
            .iter()
            .find(|o| o.id == *org.as_uuid())
            .unwrap()
            .domain_aliases,
        ["domain-before"]
    );
    rt.close().await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn reservations_survive_removal_and_runtime_cannot_modify_them(owner: PgPool) {
    let rt = runtime_role_pool(&owner).await;
    let p = PlatformProvisioner::new(Duration::minutes(15));
    let now = OffsetDateTime::now_utc();
    let org: uuid::Uuid =
        sqlx::query_scalar("SELECT platform_create_organization('reserved-forever','Customer')")
            .fetch_one(&rt)
            .await
            .unwrap();
    sqlx::query("DELETE FROM organizations WHERE id=$1")
        .bind(org)
        .execute(&owner)
        .await
        .unwrap();
    assert!(matches!(
        p.onboard_tenant(&rt, None, "reserved-forever", "Again", now)
            .await,
        Err(ProvisioningError::SlugTaken)
    ));
    for query in [
        "DELETE FROM organization_domains WHERE slug='reserved-forever'",
        "UPDATE organization_domains SET org_id=gen_random_uuid() WHERE slug='reserved-forever'",
    ] {
        assert_eq!(
            sqlx::query(query)
                .execute(&rt)
                .await
                .unwrap_err()
                .as_database_error()
                .unwrap()
                .code()
                .as_deref(),
            Some("42501")
        );
    }
    rt.close().await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn idempotent_org_insert_never_reserves_a_skipped_domain(owner: PgPool) {
    let id = uuid::Uuid::new_v4();
    let query = "INSERT INTO organizations(id,slug,name) VALUES($1,'concurrent-domain','Customer') ON CONFLICT(id) DO NOTHING";
    let (a, b) = tokio::join!(
        sqlx::query(query).bind(id).execute(&owner),
        sqlx::query(query).bind(id).execute(&owner)
    );
    assert_eq!(a.unwrap().rows_affected() + b.unwrap().rows_affected(), 1);
    sqlx::query("INSERT INTO organizations(id,slug,name) VALUES($1,'skipped-domain','Customer') ON CONFLICT(id) DO NOTHING")
        .bind(id).execute(&owner).await.unwrap();
    assert!(
        sqlx::query_scalar::<_, bool>("SELECT platform_company_domain_available('skipped-domain')")
            .fetch_one(&owner)
            .await
            .unwrap()
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn ops_request_reaches_operator_and_other_tenants_or_accounts_are_refused(owner: PgPool) {
    let rt = runtime_role_pool(&owner).await;
    let p = PlatformProvisioner::new(Duration::minutes(15));
    let now = OffsetDateTime::now_utc();
    let a = p
        .onboard_tenant(&rt, None, "request-a", "A", now)
        .await
        .unwrap();
    let b = p
        .onboard_tenant(&rt, None, "request-b", "B", now)
        .await
        .unwrap();
    let org = OrgId::from_uuid(a.organization.id);
    let ops = console_kernel_core::UserId::from_uuid(a.admin_user_id);
    let member =
        console_platform_test_support::seed_active_user(&owner, a.organization.id, "MEMBER", "HR")
            .await;
    for actor in [
        member,
        console_kernel_core::UserId::from_uuid(b.admin_user_id),
    ] {
        assert!(matches!(
            p.request_company_domain(
                &rt,
                actor,
                org,
                "requested-domain",
                "company-domain-test-key",
                now
            )
            .await,
            Err(ProvisioningError::DomainRequestForbidden)
        ));
    }
    for invalid in ["ab", "Upper", "request-a"] {
        assert!(matches!(
            p.request_company_domain(&rt, ops, org, invalid, "invalid-domain-test-key", now)
                .await,
            Err(ProvisioningError::SlugInvalid(_))
        ));
    }
    assert!(matches!(
        p.request_company_domain(&rt, ops, org, "request-b", "reserved-domain-test-key", now)
            .await,
        Err(ProvisioningError::SlugTaken)
    ));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM organization_domain_requests")
            .fetch_one(&owner)
            .await
            .unwrap(),
        0
    );
    p.request_company_domain(
        &rt,
        ops,
        org,
        "requested-domain",
        "company-domain-test-key",
        now,
    )
    .await
    .unwrap();
    let listed = p.list_tenants(&rt, None, now).await.unwrap();
    assert_eq!(
        listed
            .iter()
            .find(|o| o.id == a.organization.id)
            .unwrap()
            .pending_domain
            .as_deref(),
        Some("requested-domain")
    );
    assert_eq!(
        listed
            .iter()
            .find(|o| o.id == b.organization.id)
            .unwrap()
            .pending_domain,
        None
    );
    let audit: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE action='tenant.domain.request'",
    )
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(audit, 1);
    let renamed = p
        .rename_tenant(
            &rt,
            None,
            a.organization.id,
            Some("requested-domain"),
            None,
            now,
        )
        .await
        .unwrap();
    assert_eq!(renamed.pending_domain, None);
    assert_eq!(
        p.list_tenants(&rt, None, now)
            .await
            .unwrap()
            .iter()
            .find(|o| o.id == a.organization.id)
            .unwrap()
            .pending_domain,
        None
    );
    rt.close().await;
}
