#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn terms_are_hash_bound_once_per_version_and_old_acceptance_stays(owner: PgPool) {
    let (store, a) = tenant(&owner).await;
    let before = snapshot(&owner, &a).await;
    refused(
        &owner,
        &a,
        before,
        store.terms(&a).await.unwrap_err(),
        "terms_not_published",
    )
    .await;
    let hash = publish(&owner, "v1", "Test service terms fixture\nexact text", 2).await;
    let doc = store.terms(&a).await.unwrap();
    assert_eq!(doc.version, "v1");
    assert_eq!(doc.sha256, hash);
    assert_eq!(doc.body, "Test service terms fixture\nexact text");
    let before = snapshot(&owner, &a).await;
    refused(
        &owner,
        &a,
        before,
        store
            .accept_terms(&a, "v1".into(), "0".repeat(64))
            .await
            .unwrap_err(),
        "terms_text_changed",
    )
    .await;
    let before = snapshot(&owner, &a).await;
    refused(
        &owner,
        &a,
        before,
        store
            .accept_terms(&a, "v1".into(), "bad".into())
            .await
            .unwrap_err(),
        "validation_failed",
    )
    .await;
    store
        .accept_terms(&a, "v1".into(), hash.clone())
        .await
        .unwrap();
    assert!(
        !store
            .preview(&a)
            .await
            .unwrap()
            .blockers
            .iter()
            .any(|b| b.code == "terms_not_accepted")
    );
    let before = snapshot(&owner, &a).await;
    refused(
        &owner,
        &a,
        before,
        store.accept_terms(&a, "v1".into(), hash).await.unwrap_err(),
        "terms_version_already_accepted",
    )
    .await;
    let next = publish(&owner, "v2", "New test service terms fixture", 1).await;
    let preview = store.preview(&a).await.unwrap();
    assert!(
        preview
            .blockers
            .iter()
            .any(|b| b.code == "terms_not_accepted")
    );
    assert_eq!(
        preview.details.terms_version.as_ref().unwrap().version,
        "v2"
    );
    store.accept_terms(&a, "v2".into(), next).await.unwrap();
    assert_eq!(snapshot(&owner, &a).await.1, 2);
    let rt = store.pool();
    assert!(
        sqlx::query("UPDATE terms_documents SET body = 'changed'")
            .execute(rt)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("DELETE FROM terms_documents")
            .execute(&owner)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("UPDATE tenant_terms_acceptances SET accepted_at = now()")
            .execute(&owner)
            .await
            .is_err()
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_hr_account_cannot_accept_terms_even_with_a_legacy_admin_role(owner: PgPool) {
    let (store, a) = tenant(&owner).await;
    let hr = hr(&owner, &a).await;
    let hash = publish(&owner, "v1", "Test fixture", 1).await;
    let before = snapshot(&owner, &a).await;
    refused(
        &owner,
        &hr,
        before,
        store
            .accept_terms(&hr, "v1".into(), hash)
            .await
            .unwrap_err(),
        "forbidden",
    )
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn terms_are_global_but_acceptances_are_tenant_scoped_and_append_only(owner: PgPool) {
    let (store, a) = tenant(&owner).await;
    let (other, b) = tenant(&owner).await;
    let hash = publish(&owner, "v1", "Shared test terms fixture", 1).await;
    store
        .accept_terms(&a, "v1".into(), hash.clone())
        .await
        .unwrap();
    assert_eq!(other.terms(&b).await.unwrap().sha256, hash);
    assert!(!other.preview(&b).await.unwrap().facts.terms_accepted);
    let visible: i64 = console_platform_db::with_org_conn(other.pool(), b.org, |tx| {
        Box::pin(async move {
            Ok::<_, console_onboarding_adapter_postgres::PgOnboardingError>(
                sqlx::query_scalar("SELECT count(*) FROM tenant_terms_acceptances")
                    .fetch_one(tx.as_mut())
                    .await?,
            )
        })
    })
    .await
    .unwrap();
    assert_eq!(visible, 0);
    let unset: i64 = sqlx::query_scalar("SELECT count(*) FROM tenant_terms_acceptances")
        .fetch_one(other.pool())
        .await
        .unwrap();
    assert_eq!(unset, 0);
    assert!(
        sqlx::query("DELETE FROM tenant_terms_acceptances")
            .execute(store.pool())
            .await
            .is_err()
    );
    assert_eq!(snapshot(&owner, &a).await.1, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn legacy_acceptance_uses_current_hash_and_preserves_prior_versions(owner: PgPool) {
    let (store, a) = tenant(&owner).await;
    let hash = publish(&owner, "v1", "Legacy fixture", 2).await;
    store.accept_terms_version(&a, "v1".into()).await.unwrap();
    let stored: String = sqlx::query_scalar(
        "SELECT sha256 FROM tenant_terms_acceptances WHERE org_id = $1 AND version = 'v1'",
    )
    .bind(a.org.as_uuid())
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(stored, hash);
    let before = snapshot(&owner, &a).await;
    refused(
        &owner,
        &a,
        before,
        store
            .accept_terms_version(&a, "v1".into())
            .await
            .unwrap_err(),
        "terms_version_already_accepted",
    )
    .await;
    publish(&owner, "v2", "Revised fixture", 1).await;
    let before = snapshot(&owner, &a).await;
    refused(
        &owner,
        &a,
        before,
        store
            .accept_terms_version(&a, "v1".into())
            .await
            .unwrap_err(),
        "terms_text_changed",
    )
    .await;
    store.accept_terms_version(&a, "v2".into()).await.unwrap();
    assert_eq!(snapshot(&owner, &a).await.1, 2);
    let hr = hr(&owner, &a).await;
    let before = snapshot(&owner, &a).await;
    refused(
        &owner,
        &hr,
        before,
        store
            .accept_terms_version(&hr, "v2".into())
            .await
            .unwrap_err(),
        "forbidden",
    )
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn consent_document_edition_is_derived_from_the_published_document(pool: PgPool) {
    let (store, _) = tenant(&pool).await;
    publish(
        &pool,
        "raw-edition",
        "# Stored service title\nExact stored text",
        2,
    )
    .await;
    sqlx::query("INSERT INTO terms_documents (version,kind,body,published_at,policy_url) VALUES ('raw-privacy','privacy_notice','저장된 고지 제목\n저장된 전문',now() - interval '1 day','https://example.invalid/privacy')")
        .execute(&pool).await.unwrap();
    let documents =
        serde_json::to_value(store.published_documents().await.unwrap().unwrap()).unwrap();
    let (body, date): (String, String) = sqlx::query_as("SELECT body,(published_at AT TIME ZONE 'UTC')::date::text FROM terms_documents WHERE kind='privacy_notice' ORDER BY published_at DESC,version DESC LIMIT 1")
        .fetch_one(&pool).await.unwrap();
    let title = body
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap()
        .trim();
    assert_eq!(documents["privacy"]["title"], title);
    assert_eq!(documents["privacy"]["published_on"], date);
    assert_eq!(documents["title"], "Stored service title");
    assert_eq!(documents["privacy"]["body"], body);
}
