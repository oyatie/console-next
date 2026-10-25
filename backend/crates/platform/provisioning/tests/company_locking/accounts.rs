// SPDX-License-Identifier: LicenseRef-Proprietary
//! Both removal paths lock accounts before checking retained histories or deleting children.
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn both_removal_owners_wait_for_sorted_accounts_before_children(owner: PgPool) {
    for force in [false, true] {
        let (org, users, actor) = fixture(&owner, force).await;
        let key = opaque_key(&owner, org, users[1]).await;
        let pool = remover(&owner, force).await;
        let (held, pid) = account(&owner, users[0]).await;
        let task = tokio::spawn(async move { remove(&pool, force, org, actor).await });
        blocked(&owner, "company-removal", pid).await;
        let mut probe = owner.begin().await.unwrap();
        sqlx::query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE NOWAIT")
            .bind(users[1])
            .fetch_one(&mut *probe)
            .await
            .unwrap();
        sqlx::query("SELECT id FROM auth_webauthn_credentials WHERE id=$1 FOR UPDATE NOWAIT")
            .bind(key)
            .fetch_one(&mut *probe)
            .await
            .unwrap();
        probe.rollback().await.unwrap();
        held.rollback().await.unwrap();
        assert_eq!(
            timeout(WAIT, task).await.unwrap().unwrap().unwrap(),
            if force {
                TenantRemovalOutcome::Removed
            } else {
                TenantRemovalOutcome::BlockedHasData
            }
        );
        if !force {
            intact(&owner, org, users).await;
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn both_removal_owners_do_not_lock_company_before_authentication_finishes(owner: PgPool) {
    for force in [false, true] {
        let (org, users, actor) = fixture(&owner, force).await;
        let rt = runtime(&owner, "company-auth-first").await;
        let svc = service();
        let start = svc
            .start_registration(
                &rt,
                OrgId::from_uuid(org),
                PasskeyRegistrationStart {
                    user_id: users[0],
                    username: "Lock auth".into(),
                    display_name: "Lock auth".into(),
                },
            )
            .await
            .unwrap();
        let mut client = WebauthnAuthenticator::new(SoftPasskey::new(true));
        let signed = client
            .do_registration(
                Url::parse("https://auth.example.com").unwrap(),
                soft_passkey_challenge(start.challenge),
            )
            .unwrap();
        let mut tx = rt.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.current_org',$1,true)")
            .bind(org.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE")
            .bind(users[0])
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        let pid = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        let pool = remover(&owner, force).await;
        let task = tokio::spawn(async move { remove(&pool, force, org, actor).await });
        blocked(&owner, "company-removal", pid).await;
        // Actual registration inserts key + audit, including Company FK checks,
        // while the waiting remover must not hold an incompatible Company lock.
        timeout(
            WAIT,
            svc.finish_registration_in_tx(
                &mut tx,
                OrgId::from_uuid(org),
                start.ceremony_id,
                signed,
                OffsetDateTime::now_utc(),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(
            timeout(WAIT, task).await.unwrap().unwrap().unwrap(),
            if force {
                TenantRemovalOutcome::Removed
            } else {
                TenantRemovalOutcome::BlockedHasData
            }
        );
        if !force {
            intact(&owner, org, users).await;
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn both_removal_paths_lock_all_accounts_before_deciding_or_sweeping_children(owner: PgPool) {
    for force in [false, true] {
        let (org, users, actor) = fixture(&owner, force).await;
        let key = opaque_key(&owner, org, users[0]).await;
        let pool = remover(&owner, force).await;
        let (held, pid) = account(&owner, users[1]).await;
        let task = tokio::spawn(async move { remove(&pool, force, org, actor).await });
        blocked(&owner, "company-removal", pid).await;
        let mut probe = owner.begin().await.unwrap();
        sqlx::query("SELECT id FROM auth_webauthn_credentials WHERE id=$1 FOR UPDATE NOWAIT")
            .bind(key)
            .fetch_one(&mut *probe)
            .await
            .unwrap();
        probe.rollback().await.unwrap();
        held.rollback().await.unwrap();
        assert_eq!(
            timeout(WAIT, task).await.unwrap().unwrap().unwrap(),
            if force {
                TenantRemovalOutcome::Removed
            } else {
                TenantRemovalOutcome::BlockedHasData
            }
        );
        if !force {
            intact(&owner, org, users).await;
        }
    }
}
