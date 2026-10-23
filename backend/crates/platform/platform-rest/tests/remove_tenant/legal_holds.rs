// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrations = "../db/migrations")]
async fn held_tenant_refuses_both_http_removals_with_typed_conflict(owner_pool: PgPool) {
    let harness = Harness::new(&owner_pool).await;
    let admin = seed_platform_admin(&owner_pool).await;
    let token = harness.token(admin, OrgId::platform(), true).await;
    let mut key = real_key(&owner_pool, admin).await;
    let service = harness.service();
    let target = onboard(&service, &token, "held").await;
    archive_org(&service, &token, target).await;
    let hold: Uuid = sqlx::query_scalar("SELECT audit_legal_hold_place($1,'HTTP-CASE','order','preserve',$2,repeat('a',32)::char(32),repeat('b',16)::char(16),now())")
        .bind(target).bind(*admin.as_uuid()).fetch_one(&owner_pool).await.unwrap();
    let before = count_in_org(&owner_pool, "users", target).await;
    for force in [false, true] {
        let (status, body) = if force {
            force_delete_org(&service, &token, target, Some((&owner_pool, &mut key))).await
        } else {
            delete_org(&service, &token, target).await
        };
        assert_eq!(status, StatusCode::CONFLICT, "{body:?}");
        assert_eq!(body["error"]["code"], "blocked_legal_hold");
        assert!(org_exists(&owner_pool, target).await);
        assert_eq!(count_in_org(&owner_pool, "users", target).await, before);
    }
    sqlx::query("SELECT audit_legal_hold_release($1,'closed',$2,repeat('c',32)::char(32),repeat('d',16)::char(16),now())")
        .bind(hold).bind(*admin.as_uuid()).execute(&owner_pool).await.unwrap();
    let (status, body) = delete_org(&service, &token, target).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body:?}");
    assert_eq!(body["error"]["code"], "tenant_has_data");
    let (status, body) =
        force_delete_org(&service, &token, target, Some((&owner_pool, &mut key))).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body:?}");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn force_remove_of_sentinel_is_not_found(owner_pool: PgPool) {
    let harness = Harness::new(&owner_pool).await;
    let admin = seed_platform_admin(&owner_pool).await;
    let platform_token = harness.token(admin, OrgId::platform(), true).await;
    let mut key = real_key(&owner_pool, admin).await;
    let service = harness.service();

    let (status, _body) = force_delete_org(
        &service,
        &platform_token,
        *OrgId::platform().as_uuid(),
        Some((&owner_pool, &mut key)),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "the platform sentinel must never be force-removable"
    );
    assert!(
        org_exists(&owner_pool, *OrgId::platform().as_uuid()).await,
        "the sentinel org must still exist"
    );
}
