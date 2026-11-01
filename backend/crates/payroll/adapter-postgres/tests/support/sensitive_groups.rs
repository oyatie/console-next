// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn sensitive_pay_groups_require_separate_live_entity_clearance(pool: PgPool) {
    let org = OrgId::new();
    let actor = seed_org_and_super_admin(&pool, *org.as_uuid(), "sensitive-pay-groups").await;
    let a = entity(&pool, org).await;
    let b = entity(&pool, org).await;
    pay_access::grant_manage(&pool, org, actor, None).await;
    let store = PgPayrollStore::new(runtime_role_pool(&pool).await);
    let regular = store.create_pay_group(org, actor, input(a)).await.unwrap();
    let mut sensitive = input(a);
    sensitive.sensitive = true;
    assert_eq!(
        store
            .create_pay_group(org, actor, sensitive.clone())
            .await
            .unwrap_err()
            .kind(),
        ErrorKind::Forbidden
    );
    pay_access::grant_sensitive(&pool, org, actor, Some(b), "edit").await;
    assert_eq!(
        store
            .create_pay_group(org, actor, sensitive.clone())
            .await
            .unwrap_err()
            .kind(),
        ErrorKind::Forbidden
    );
    pay_access::grant_sensitive(&pool, org, actor, Some(a), "view").await;
    assert_eq!(
        store
            .create_pay_group(org, actor, sensitive.clone())
            .await
            .unwrap_err()
            .kind(),
        ErrorKind::Forbidden
    );
    assert_eq!(
        audit_count(&pool, actor).await,
        1,
        "refused sensitive creates leave no successful audit"
    );
    pay_access::grant_sensitive(&pool, org, actor, Some(a), "edit").await;
    let secret = store.create_pay_group(org, actor, sensitive).await.unwrap();
    let reader = seed_active_user(&pool, *org.as_uuid(), "MEMBER", "sensitive-pay-reader").await;
    pay_access::grant_view(&pool, org, reader, None).await;
    pay_access::grant_sensitive(&pool, org, reader, Some(b), "view").await;
    assert_eq!(
        store
            .list_pay_groups(org, reader)
            .await
            .unwrap()
            .items
            .iter()
            .map(|g| g.id)
            .collect::<Vec<_>>(),
        vec![regular.id]
    );
    let clearance = pay_access::grant_sensitive(&pool, org, reader, Some(a), "view").await;
    assert_eq!(
        store
            .list_pay_groups(org, reader)
            .await
            .unwrap()
            .items
            .len(),
        2
    );
    assert_eq!(
        store
            .create_pay_group(org, reader, input(a))
            .await
            .unwrap_err()
            .kind(),
        ErrorKind::Forbidden
    );
    // rls-arming: ok revoke between reads to prove the next snapshot uses live clearance.
    sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=granted_by WHERE id=$1")
        .bind(clearance).execute(&pool).await.unwrap();
    assert!(
        !store
            .list_pay_groups(org, reader)
            .await
            .unwrap()
            .items
            .iter()
            .any(|g| g.id == secret.id)
    );
    let cleared_only = seed_active_user(&pool, *org.as_uuid(), "MEMBER", "sensitive-only").await;
    pay_access::grant_sensitive(&pool, org, cleared_only, None, "edit").await;
    assert_eq!(
        store
            .list_pay_groups(org, cleared_only)
            .await
            .unwrap_err()
            .kind(),
        ErrorKind::Forbidden
    );
    let foreign = OrgId::new();
    let outsider =
        seed_org_and_super_admin(&pool, *foreign.as_uuid(), "foreign-sensitive-pay").await;
    pay_access::grant_manage(&pool, foreign, outsider, None).await;
    pay_access::grant_sensitive(&pool, foreign, outsider, None, "edit").await;
    assert!(
        store
            .list_pay_groups(foreign, outsider)
            .await
            .unwrap()
            .items
            .is_empty()
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn tenant_pay_grant_never_offers_voided_legal_entities(pool: PgPool) {
    let org = OrgId::new();
    let actor = seed_org_and_super_admin(&pool, *org.as_uuid(), "voided-pay-entity").await;
    let active = entity(&pool, org).await;
    let voided = entity(&pool, org).await;
    pay_access::grant_manage(&pool, org, actor, None).await;
    let store = PgPayrollStore::new(runtime_role_pool(&pool).await);
    store
        .create_pay_group(org, actor, input(voided))
        .await
        .unwrap();
    // rls-arming: ok owner seeds a mistaken entity void; reads run with console_rt.
    sqlx::query("UPDATE legal_entities SET voided_at=now(),void_reason_code='MISTAKE' WHERE id=$1")
        .bind(voided)
        .execute(&pool)
        .await
        .unwrap();
    let page = store.list_pay_groups(org, actor).await.unwrap();
    assert_eq!(
        page.legal_entities.iter().map(|e| e.id).collect::<Vec<_>>(),
        vec![active]
    );
    assert!(page.items.is_empty());
    assert_eq!(
        store
            .create_pay_group(org, actor, input(voided))
            .await
            .unwrap_err()
            .kind(),
        ErrorKind::Forbidden
    );
}
