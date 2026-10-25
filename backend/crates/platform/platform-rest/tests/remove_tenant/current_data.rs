// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_registered_legal_entity_disables_and_refuses_guarded_removal(owner: PgPool) {
    let h = Harness::new(&owner).await;
    let admin = seed_platform_admin(&owner).await;
    let token = h.token(admin, OrgId::platform(), true).await;
    let service = h.service();
    let org = onboard(&service, &token, "erase-current-data").await;
    sqlx::query("INSERT INTO legal_entities(org_id,needs_confirmation,created_change_mode) VALUES($1,true,'MIGRATION')")
        .bind(org).execute(&owner).await.unwrap();
    let removable: bool = sqlx::query_scalar("SELECT removable FROM platform_tenant_facts($1)")
        .bind(org)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert!(!removable);
    let (status, body) = delete_org(&service, &token, org).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "tenant_has_data");
    assert!(org_exists(&owner, org).await);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn bootstrap_binding_is_a_shell_but_later_ops_person_history_is_retained(owner: PgPool) {
    let h = Harness::new(&owner).await;
    let admin = seed_platform_admin(&owner).await;
    let token = h.token(admin, OrgId::platform(), true).await;
    let service = h.service();
    let org = onboard(&service, &token, "erase-ops-history").await;
    let fresh: bool = sqlx::query_scalar("SELECT removable FROM platform_tenant_facts($1)")
        .bind(org)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert!(
        fresh,
        "the initial first-admin binding belongs to the removable onboarding shell"
    );
    sqlx::query(
        "UPDATE users SET display_name='Recorded account holder' WHERE org_id=$1 AND is_tenant_ops",
    )
    .bind(org)
    .execute(&owner)
    .await
    .unwrap();
    let versions: i64 = sqlx::query_scalar("SELECT count(*) FROM person_revisions WHERE org_id=$1")
        .bind(org)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(
        versions, 2,
        "a canonical account edit appends real Person history"
    );
    let removable: bool = sqlx::query_scalar("SELECT removable FROM platform_tenant_facts($1)")
        .bind(org)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert!(!removable);
    let (status, body) = delete_org(&service, &token, org).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "tenant_has_data");
    assert!(org_exists(&owner, org).await);
    let retained: i64 = sqlx::query_scalar("SELECT count(*) FROM person_revisions WHERE org_id=$1")
        .bind(org)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(retained, versions);
}
