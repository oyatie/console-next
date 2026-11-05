// SPDX-License-Identifier: LicenseRef-Proprietary

use super::*;

#[sqlx::test(migrator = "MIGRATOR")]
async fn admin_issue_otp_preserves_live_code_without_access_authority(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_key_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let branch_id = seed_branch(&pool, "Issue Grant Region", "Issue Grant Branch").await;
    let admin_id =
        seed_user_with_branch(&pool, "Issue Admin", "010-6120-0000", "ADMIN", branch_id).await;
    let target_id = seed_user_with_branch(
        &pool,
        "Granted Invitee",
        "010-1234-0130",
        "MECHANIC",
        branch_id,
    )
    .await;

    let role_id = seed_credential_role(&pool, admin_id, true).await;
    let access_only_role = seed_credential_role(&pool, admin_id, false).await;
    sqlx::query(
        "INSERT INTO access_grants \
         (org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by) \
         VALUES ($1,$2,$3,'TENANT',now()-interval '1 day',true,'SETUP','TEST',$4)",
    )
    .bind(OrgId::one().as_uuid())
    .bind(target_id.as_uuid())
    .bind(role_id)
    .bind(admin_id.as_uuid())
    .execute(&pool)
    .await
    .unwrap();

    let live = BootstrapCredentialStore
        .issue_for_zero_credential_user(
            &pool,
            None,
            *target_id.as_uuid(),
            OrgId::one(),
            OffsetDateTime::now_utc(),
            Duration::hours(1),
        )
        .await
        .unwrap();
    let service =
        build_router(app_state(pool.clone(), private_key_pem.to_string(), public_key_pem).unwrap());
    let (admin_access, mut admin_key, admin_credential) =
        passkey_session_with_key(&service, &pool, admin_id).await;
    for authority in [None, Some(access_only_role), Some(role_id)] {
        if let Some(role) = authority {
            sqlx::query(
                "INSERT INTO access_grants \
                 (org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by) \
                 VALUES ($1,$2,$3,'TENANT',now()-interval '1 day',true,'SETUP','TEST',$4)",
            )
            .bind(OrgId::one().as_uuid())
            .bind(admin_id.as_uuid())
            .bind(role)
            .bind(target_id.as_uuid())
            .execute(&pool)
            .await
            .unwrap();
        }
        let step_up = start_step_up_assertion(&service, &mut admin_key, &admin_credential).await;
        let response = post_raw(
            service.clone(),
            "/api/v1/auth/admin/otp/issue",
            Some(&admin_access),
            json!({ "user_id": target_id.as_uuid(), "branch_id": branch_id, "step_up": step_up }),
        )
        .await;
        let authorized = authority == Some(role_id);
        assert_eq!(
            response.status(),
            if authorized {
                StatusCode::OK
            } else {
                StatusCode::FORBIDDEN
            }
        );
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        if !authorized {
            assert_eq!(body["error"]["code"], "credential_reset_authority_required");
        }
        let credentials: Vec<(Uuid, Option<OffsetDateTime>)> = sqlx::query_as(
            "SELECT id, revoked_at FROM auth_bootstrap_credentials WHERE user_id=$1 ORDER BY issued_at",
        )
        .bind(target_id.as_uuid())
        .fetch_all(&pool)
        .await
        .unwrap();
        if authorized {
            assert_eq!(credentials.len(), 2);
            assert_eq!(credentials[0].0, live.credential_id);
            assert!(credentials[0].1.is_some());
            assert!(credentials[1].1.is_none());
        } else {
            assert_eq!(credentials, vec![(live.credential_id, None)]);
        }
    }
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn admin_issue_otp_refuses_grants_committed_while_locking_authority(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_key_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let branch_id = seed_branch(&pool, "Concurrent Region", "Concurrent Branch").await;
    let admin_id =
        seed_user_with_branch(&pool, "Issue Admin", "010-6130-0000", "ADMIN", branch_id).await;
    let target_id =
        seed_user_with_branch(&pool, "Invitee", "010-1234-0131", "MECHANIC", branch_id).await;
    let actor_role = seed_credential_role(&pool, admin_id, true).await;
    let target_role = seed_credential_role(&pool, admin_id, false).await;
    sqlx::query(
        "INSERT INTO access_grants \
         (org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by) \
         VALUES ($1,$2,$3,'TENANT',now()-interval '1 day',true,'SETUP','TEST',$4)",
    )
    .bind(OrgId::one().as_uuid())
    .bind(admin_id.as_uuid())
    .bind(actor_role)
    .bind(target_id.as_uuid())
    .execute(&pool)
    .await
    .unwrap();
    let service =
        build_router(app_state(pool.clone(), private_key_pem.to_string(), public_key_pem).unwrap());
    let (admin_access, mut admin_key, admin_credential) =
        passkey_session_with_key(&service, &pool, admin_id).await;
    let step_up = start_step_up_assertion(&service, &mut admin_key, &admin_credential).await;
    let mut held = pool.begin().await.unwrap();
    sqlx::query(
        "INSERT INTO access_grants \
         (org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by) \
         VALUES ($1,$2,$3,'TENANT',now()-interval '1 day',true,'SETUP','TEST',$4)",
    )
    .bind(OrgId::one().as_uuid())
    .bind(target_id.as_uuid())
    .bind(target_role)
    .bind(admin_id.as_uuid())
    .execute(held.as_mut())
    .await
    .unwrap();
    let blocker: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(held.as_mut())
        .await
        .unwrap();
    let target = *target_id.as_uuid();
    let request = tokio::spawn(async move {
        post_raw(
            service,
            "/api/v1/auth/admin/otp/issue",
            Some(&admin_access),
            json!({ "user_id": target, "branch_id": branch_id, "step_up": step_up }),
        )
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            let waiting: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
                 AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid)))",
            )
            .bind(blocker)
            .fetch_one(&pool)
            .await
            .unwrap();
            if waiting {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("credential issue must wait for the account's grant writer");
    held.commit().await.unwrap();
    let refused = request.await.unwrap();
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    let body: Value =
        serde_json::from_slice(&to_bytes(refused.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body["error"]["code"], "credential_reset_authority_required");
    let codes: i64 =
        sqlx::query_scalar("SELECT count(*) FROM auth_bootstrap_credentials WHERE user_id=$1")
            .bind(target_id.as_uuid())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(codes, 0);
}
