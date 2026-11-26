use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn duplicate_folder_copy_advances_only_its_imap_cursor(owner_pool: PgPool) {
    let store = PgMailStore::new(runtime_role_pool(&owner_pool).await);
    let org = OrgId::one();
    seed_org(&owner_pool, *org.as_uuid(), "A").await;
    let actor = seed_active_user(&owner_pool, *org.as_uuid()).await;
    let account = seed_account(&store, &test_cipher(), org, actor).await;
    let inbox = store
        .upsert_folders(org, account, &[inbox_folder()])
        .await
        .unwrap()[0]
        .folder_id;
    let archive = ImapFolder {
        imap_path: "Archive".into(),
        name: "Archive".into(),
        role: FolderRole::Archive,
    };
    let other = store
        .upsert_folders(org, account, &[archive])
        .await
        .unwrap()[0]
        .folder_id;
    assert!(
        store
            .upsert_inbound(org, upsert_for(account, inbox, message(4, "Quote")))
            .await
            .unwrap()
    );
    let mut copy = message(4, "Quote");
    copy.imap_uid = 78;
    assert!(
        !store
            .upsert_inbound(org, upsert_for(account, other, copy))
            .await
            .unwrap()
    );
    let mut webhook = upsert_for(account, other, message(9981, "Delivered"));
    webhook.uid_validity = 0;
    assert!(store.upsert_inbound(org, webhook).await.unwrap());
    let cursor: (i64, i64) =
        sqlx::query_as("SELECT uid_validity, last_seen_uid FROM email_folders WHERE id = $1")
            .bind(other)
            .fetch_one(&owner_pool)
            .await
            .unwrap();
    assert_eq!(cursor, (1, 78));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn retries_use_only_durable_attachment_keys(owner_pool: PgPool) {
    use console_comms_application::{
        FetchedAttachment, MailAttachmentStore, MailFuture, MailServiceError, mail_attachment_key,
    };
    use std::sync::{Arc, Mutex};

    struct Objects {
        db: PgPool,
        puts: Mutex<Vec<String>>,
    }

    impl MailAttachmentStore for Objects {
        fn put<'a>(
            &'a self,
            key: String,
            _content_type: String,
            _bytes: Vec<u8>,
        ) -> MailFuture<'a, Result<(), MailServiceError>> {
            Box::pin(async move {
                // This independent session sees exactly what the erase inventory sees
                // even if the caller loses the PUT acknowledgement or rolls back.
                let state: String = sqlx::query_scalar(
                    "SELECT upload_state FROM email_attachments WHERE s3_key = $1",
                )
                .bind(&key)
                .fetch_one(&self.db)
                .await
                .unwrap();
                assert_eq!(state, "PENDING");
                let mut puts = self.puts.lock().unwrap();
                puts.push(key);
                if puts.len() == 2 {
                    return Err(MailServiceError::Transport {
                        code: "lost_put_ack",
                    });
                }
                Ok(())
            })
        }

        fn presign_get<'a>(
            &'a self,
            _key: &'a str,
        ) -> MailFuture<'a, Result<String, MailServiceError>> {
            unreachable!("test does not issue presigned URLs")
        }
    }

    let store = PgMailStore::new(runtime_role_pool(&owner_pool).await);
    let org = OrgId::one();
    seed_org(&owner_pool, *org.as_uuid(), "A").await;
    let actor = seed_active_user(&owner_pool, *org.as_uuid()).await;
    let account = seed_account(&store, &test_cipher(), org, actor).await;
    let folder = store
        .upsert_folders(org, account, &[inbox_folder()])
        .await
        .unwrap()[0]
        .folder_id;
    let objects = Arc::new(Objects {
        db: owner_pool.clone(),
        puts: Mutex::default(),
    });
    let receipt = || {
        let mut upsert = upsert_for(account, folder, message(50, "Photos"));
        for ordinal in 1..=2 {
            let filename = format!("photo{ordinal}.jpg");
            let part = FetchedAttachment {
                filename: filename.clone(),
                content_type: "image/jpeg".into(),
                bytes: vec![5],
                content_id: None,
                is_inline: false,
            };
            upsert.stored_attachments.push(StoredAttachment {
                s3_key: mail_attachment_key(org, account, upsert.id, ordinal, &filename),
                filename,
                content_type: part.content_type.clone(),
                size_bytes: 1,
                content_id: None,
                is_inline: false,
                sort_order: ordinal,
            });
            upsert.message.attachments.push(part);
        }
        upsert
    };
    let first = receipt();
    let first_key = first.stored_attachments[0].s3_key.clone();
    let second_key = first.stored_attachments[1].s3_key.clone();
    assert!(matches!(
        store.sync_inbound(org, first, objects.clone()).await,
        Err(MailServiceError::Transport {
            code: "lost_put_ack"
        })
    ));
    let cursor = || {
        sqlx::query_scalar::<_, i64>("SELECT last_seen_uid FROM email_folders WHERE id = $1")
            .bind(folder)
            .fetch_one(&owner_pool)
    };
    assert_eq!(cursor().await.unwrap(), 0);
    let pending: Uuid = sqlx::query_scalar(
        "SELECT id FROM email_attachments WHERE s3_key = $1 AND upload_state = 'PENDING'",
    )
    .bind(&second_key)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert!(
        store
            .get_attachment_key(org, pending)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        !store
            .sync_inbound(org, receipt(), objects.clone())
            .await
            .unwrap()
    );
    assert_eq!(cursor().await.unwrap(), 50);
    assert_eq!(
        store
            .get_attachment_key(org, pending)
            .await
            .unwrap()
            .unwrap()
            .s3_key,
        second_key
    );
    assert!(
        !store
            .sync_inbound(org, receipt(), objects.clone())
            .await
            .unwrap()
    );
    assert_eq!(
        *objects.puts.lock().unwrap(),
        [first_key, second_key.clone(), second_key]
    );
}

// ===========================================================================
// Idempotency: re-syncing the same (uid_validity, uid) inserts no duplicate.
// ===========================================================================
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn inbound_upsert_is_idempotent_as_runtime_role(owner_pool: PgPool) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let org = OrgId::one();
    seed_org(&owner_pool, *org.as_uuid(), "A").await;
    let actor = seed_active_user(&owner_pool, *org.as_uuid()).await;
    let cipher = test_cipher();
    let store = PgMailStore::new(rt_pool.clone());

    let account = seed_account(&store, &cipher, org, actor).await;
    let cursors = CURRENT_ORG
        .scope(org, store.upsert_folders(org, account, &[inbox_folder()]))
        .await
        .expect("upsert folders");
    let folder_id = cursors[0].folder_id;

    // First insert is NEW.
    let first = CURRENT_ORG
        .scope(
            org,
            store.upsert_inbound(org, upsert_for(account, folder_id, message(10, "Quote"))),
        )
        .await
        .expect("first upsert");
    assert!(first, "first sight of a UID inserts a NEW message");

    // Re-syncing the SAME (uid_validity, uid) is a no-op (returns false).
    let second = CURRENT_ORG
        .scope(
            org,
            store.upsert_inbound(org, upsert_for(account, folder_id, message(10, "Quote"))),
        )
        .await
        .expect("second upsert");
    assert!(
        !second,
        "re-syncing the same UID must NOT insert a duplicate"
    );

    // Exactly one message row exists (verified as owner).
    let count: i64 = {
        let mut tx = owner_pool.begin().await.unwrap();
        sqlx::query("SET LOCAL row_security = off")
            .execute(&mut *tx)
            .await
            .unwrap();
        let n: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM email_messages WHERE account_id = $1 AND imap_uid = 10",
        )
        .bind(*account.as_uuid())
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        tx.commit().await.unwrap();
        n
    };
    assert_eq!(count, 1, "no duplicate row for a re-synced UID");
}
