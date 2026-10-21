//! Frozen company-domain intents replay without duplicate effects or replacing newer changes.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_kernel_core::{OrgId, UserId};
use console_platform_provisioning::{PlatformProvisioner, ProvisioningError, TenantRename};
use console_platform_test_support::runtime_role_pool;
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn domain_commands_replay_once_without_overwriting_later_changes(owner: PgPool) {
    let rt = runtime_role_pool(&owner).await;
    let p = PlatformProvisioner::new(Duration::minutes(15));
    let now = OffsetDateTime::now_utc();
    let a = p
        .onboard_tenant(&rt, None, "replay-before", "A", now)
        .await
        .unwrap();
    let org = OrgId::from_uuid(a.organization.id);
    let ops = UserId::from_uuid(a.admin_user_id);
    let key = "domain-replay-intent-key";
    p.request_company_domain(&rt, ops, org, "replay-after", key, now)
        .await
        .unwrap();
    p.request_company_domain(&rt, ops, org, "replay-after", key, now)
        .await
        .unwrap();
    assert!(matches!(
        p.request_company_domain(&rt, ops, org, "different-domain", key, now)
            .await,
        Err(ProvisioningError::Conflict(_))
    ));
    let rename_key = "rename-replay-intent-key";
    let input = || TenantRename {
        slug: Some("replay-after"),
        name: None,
        idempotency_key: Some(rename_key),
    };
    let first = p
        .rename_tenant_with_key(&rt, None, a.organization.id, input(), now)
        .await
        .unwrap();
    p.rename_tenant(
        &rt,
        None,
        a.organization.id,
        Some("replay-newer"),
        None,
        now,
    )
    .await
    .unwrap();
    assert_eq!(
        p.rename_tenant_with_key(&rt, None, a.organization.id, input(), now)
            .await
            .unwrap(),
        first
    );
    p.request_company_domain(&rt, ops, org, "replay-after", key, now)
        .await
        .unwrap();
    assert_eq!(
        p.own_company_domain_request(&rt, ops, org).await.unwrap(),
        None
    );
    assert!(matches!(
        p.rename_tenant_with_key(
            &rt,
            None,
            a.organization.id,
            TenantRename {
                slug: Some("different-domain"),
                name: None,
                idempotency_key: Some(rename_key)
            },
            now
        )
        .await,
        Err(ProvisioningError::Conflict(_))
    ));
    let current = p.list_tenants(&rt, None, now).await.unwrap();
    assert_eq!(
        current
            .iter()
            .find(|o| o.id == a.organization.id)
            .unwrap()
            .slug,
        "replay-newer"
    );
    let (requests, renames, notices): (i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='tenant.domain.request'), \
                (SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='platform.tenant.rename'), \
                (SELECT count(*) FROM notifications WHERE org_id=$1 AND category='tenant.domain.change')")
        .bind(a.organization.id).fetch_one(&owner).await.unwrap();
    assert_eq!((requests, renames, notices), (1, 2, 2));
    rt.close().await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn requesting_and_renaming_share_the_same_lock_order(owner: PgPool) {
    let rt = runtime_role_pool(&owner).await;
    let p = PlatformProvisioner::new(Duration::minutes(15));
    let now = OffsetDateTime::now_utc();
    let a = p
        .onboard_tenant(&rt, None, "race-before", "A", now)
        .await
        .unwrap();
    let org = OrgId::from_uuid(a.organization.id);
    let result = tokio::time::timeout(std::time::Duration::from_secs(8), async {
        tokio::join!(
            p.request_company_domain(
                &rt,
                UserId::from_uuid(a.admin_user_id),
                org,
                "race-request",
                "race-request-intent-key",
                now
            ),
            p.rename_tenant(&rt, None, a.organization.id, Some("race-after"), None, now)
        )
    })
    .await
    .expect("request and rename cannot deadlock");
    result.0.unwrap();
    result.1.unwrap();
    assert_eq!(
        p.own_company_domain_request(&rt, UserId::from_uuid(a.admin_user_id), org)
            .await
            .unwrap()
            .as_deref(),
        Some("race-request")
    );
    rt.close().await;
}
