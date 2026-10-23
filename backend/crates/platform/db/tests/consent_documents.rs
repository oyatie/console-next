// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
//! A fresh release publishes reader documents without a fixture or mutable legal text.
use sqlx::PgPool;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[sqlx::test(migrator = "MIGRATOR")]
async fn migrations_publish_reader_documents_and_preserve_old_versions(pool: PgPool) {
    for kind in ["service_terms", "privacy_notice"] {
        let (version, body, hash_matches, review): (String, String, bool, bool) = sqlx::query_as(
            "SELECT version,body,sha256=encode(digest(body,'sha256'),'hex'),review_pending FROM terms_documents WHERE kind=$1 AND published_at<=now() ORDER BY published_at DESC,version DESC LIMIT 1",
        ).bind(kind).fetch_one(&pool).await.unwrap();
        assert!(hash_matches);
        assert!(review);
        assert!(body.contains("2026년 10월 22일"));
        for editor_text in [
            "게시 전",
            "<a id=",
            "【",
            "privacy-policy-facts",
            "console-next",
            "# ",
            "|---",
        ] {
            assert!(!body.contains(editor_text), "{kind}: {editor_text}");
        }
        assert!(
            sqlx::query("UPDATE terms_documents SET body='replacement' WHERE version=$1")
                .bind(&version)
                .execute(&pool)
                .await
                .is_err()
        );
        assert!(
            sqlx::query("DELETE FROM terms_documents WHERE version=$1")
                .bind(&version)
                .execute(&pool)
                .await
                .is_err()
        );
    }
    let original: String = sqlx::query_scalar(
        "SELECT body FROM terms_documents WHERE version='kr-pipa-draft-2026-10-20'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        original.contains("게시 전"),
        "historical evidence must remain byte-exact"
    );
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn runtime_can_schedule_publication_without_reading_unpublished_text(pool: PgPool) {
    sqlx::query("INSERT INTO terms_documents(version,body,published_at) VALUES ('future-consent','Unpublished text',now()+interval '1 day')").execute(&pool).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE console_rt")
        .execute(tx.as_mut())
        .await
        .unwrap();
    let visible: i64 =
        sqlx::query_scalar("SELECT count(*) FROM terms_documents WHERE version='future-consent'")
            .fetch_one(tx.as_mut())
            .await
            .unwrap();
    assert_eq!(visible, 0);
    let scheduled: bool = sqlx::query_scalar("SELECT next_consent_publication() > now()")
        .fetch_one(tx.as_mut())
        .await
        .unwrap();
    assert!(scheduled);
}
