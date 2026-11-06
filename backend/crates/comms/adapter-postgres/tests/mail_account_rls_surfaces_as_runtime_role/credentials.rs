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
    for (smtp_version, imap_version, replace_smtp, replace_imap) in
        [(1, 1, true, true), (2, 1, true, false), (2, 2, false, true)]
    {
        let mut upsert = upsert_for(org, account_id, actor, &cipher);
        upsert.smtp_password.as_mut().unwrap().key_version = smtp_version;
        upsert.imap_password.as_mut().unwrap().key_version = imap_version;
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
        // Once both are current, persisted envelopes authenticate on both paths.
        if smtp_version == 2 && imap_version == 2 {
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
}
