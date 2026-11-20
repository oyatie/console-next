// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

// The port treats each credential as opaque; distinct suite tags model an
// account whose two secrets were last replaced by different writer versions.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn password_versions_survive_independent_replacements(owner_pool: PgPool) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let org = OrgId::one();
    seed_org(&owner_pool, *org.as_uuid(), "A").await;
    let actor = seed_active_user(&owner_pool, *org.as_uuid()).await;
    let cipher = test_cipher();
    let account_id = EmailAccountId::new();
    let store = PgMailStore::new(rt_pool);
    for (smtp_version, imap_version, replace_smtp, replace_imap) in [
        (1, 1, true, true),
        (2, 1, true, false),
        (2, 2, false, true),
        (3, 2, true, false),
        (3, 3, false, true),
    ] {
        let mut upsert = upsert_for(org, account_id, actor, &cipher);
        for (secret, suite, field, plaintext) in [
            (
                &mut upsert.smtp_password,
                smtp_version,
                "smtp_password",
                b"smtp-secret",
            ),
            (
                &mut upsert.imap_password,
                imap_version,
                "imap_password",
                b"imap-secret",
            ),
        ] {
            *secret = Some(
                cipher
                    .encrypt_with_suite(
                        suite,
                        plaintext,
                        Aad {
                            org_id: &org.to_string(),
                            account_id: &account_id.to_string(),
                            field,
                        },
                    )
                    .unwrap(),
            );
        }
        if !replace_smtp {
            upsert.smtp_password = None;
        }
        if !replace_imap {
            upsert.imap_password = None;
        }
        let audit = account_config_audit_event(
            actor,
            account_id,
            TraceContext::generate(),
            OffsetDateTime::now_utc(),
        )
        .unwrap()
        .with_org(org);
        CURRENT_ORG
            .scope(org, store.upsert_account(upsert, audit))
            .await
            .unwrap();
        let stored = CURRENT_ORG
            .scope(org, store.get_account())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.smtp_password.key_version, smtp_version);
        assert_eq!(stored.imap_password.key_version, imap_version);
        // Every step (including mixed-version partial updates) authenticates both persisted envelopes.
        for (secret, field, expected) in [
            (&stored.smtp_password, "smtp_password", b"smtp-secret"),
            (&stored.imap_password, "imap_password", b"imap-secret"),
        ] {
            assert_eq!(
                cipher
                    .open_bytes(
                        secret,
                        Aad {
                            org_id: &org.to_string(),
                            account_id: &account_id.to_string(),
                            field
                        }
                    )
                    .unwrap(),
                expected
            );
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn email_accounts_v3_envelope_shape_rejects_null_or_mismatched_fields(owner_pool: PgPool) {
    let org = OrgId::one();
    seed_org(&owner_pool, *org.as_uuid(), "ShapeCheck").await;
    let actor = seed_active_user(&owner_pool, *org.as_uuid()).await;
    let cipher = test_cipher();
    let account_id = EmailAccountId::new();
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let store = PgMailStore::new(rt_pool);

    let mut upsert = upsert_for(org, account_id, actor, &cipher);
    let mut smtp_aad_buf = (org.to_string(), account_id.to_string());
    let smtp_v3 = cipher
        .encrypt_with_suite(
            3,
            b"smtp-v3",
            Aad {
                org_id: &smtp_aad_buf.0,
                account_id: &smtp_aad_buf.1,
                field: "smtp_password",
            },
        )
        .unwrap();
    let imap_v3 = cipher
        .encrypt_with_suite(
            3,
            b"imap-v3",
            Aad {
                org_id: &smtp_aad_buf.0,
                account_id: &smtp_aad_buf.1,
                field: "imap_password",
            },
        )
        .unwrap();
    smtp_aad_buf.0.clear();
    upsert.smtp_password = Some(smtp_v3);
    upsert.imap_password = Some(imap_v3);
    let audit = account_config_audit_event(
        actor,
        account_id,
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .unwrap()
    .with_org(org);
    CURRENT_ORG
        .scope(org, store.upsert_account(upsert, audit))
        .await
        .unwrap();

    for assignment in [
        "smtp_msg_id = NULL",
        "smtp_commitment_tag = NULL",
        "kek_id = NULL",
        "alg_id = NULL",
        "alg_id = 'reserved-mlkem768-aes256-gcm'",
        "dek_nonce = decode('00', 'hex')",
        "dek_wrapped = decode('00', 'hex')",
        "key_version = 4",
        "imap_msg_id = NULL",
        "imap_commitment_tag = NULL",
        "imap_kek_id = NULL",
        "imap_alg_id = NULL",
        "imap_alg_id = 'reserved-mlkem768-aes256-gcm'",
        "imap_dek_nonce = decode('00', 'hex')",
        "imap_dek_wrapped = decode('00', 'hex')",
        "imap_key_version = 4",
    ] {
        let mut tx = owner_pool.begin().await.unwrap();
        sqlx::query("SET LOCAL row_security = off")
            .execute(&mut *tx)
            .await
            .unwrap();
        let err = sqlx::query(sqlx::AssertSqlSafe(format!(
            "UPDATE email_accounts SET {assignment} WHERE id = $1"
        )))
        .bind(*account_id.as_uuid())
        .execute(&mut *tx)
        .await
        .unwrap_err();
        assert_eq!(
            err.as_database_error().unwrap().code().as_deref(),
            Some("23514"),
            "expected check_violation for {assignment}"
        );
        let _ = tx.rollback().await;
    }
}
