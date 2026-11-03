// SPDX-License-Identifier: LicenseRef-Proprietary

use super::*;

#[sqlx::test(migrator = "MIGRATOR")]
async fn credential_reset_requires_authority_over_the_targets_access_grants(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_key_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let branch_id = seed_branch(&pool, "Grant Region", "Grant Branch").await;
    let admin_id =
        seed_user_with_branch(&pool, "Reset Admin", "010-6110-0000", "ADMIN", branch_id).await;
    let target_id = seed_user_with_branch(
        &pool,
        "Granted Target",
        "010-1234-0127",
        "MECHANIC",
        branch_id,
    )
    .await;
    let scheduled_target_id = seed_user_with_branch(
        &pool,
        "Scheduled Target",
        "010-1234-0128",
        "MECHANIC",
        branch_id,
    )
    .await;
    let pending_target_id = seed_user_with_branch(
        &pool,
        "Pending Target",
        "010-1234-0129",
        "MECHANIC",
        branch_id,
    )
    .await;
    console_platform_test_support::seed_passkey(&pool, OrgId::one(), target_id).await;
    console_platform_test_support::seed_passkey(&pool, OrgId::one(), scheduled_target_id).await;
    console_platform_test_support::seed_passkey(&pool, OrgId::one(), pending_target_id).await;

    let role_id = seed_credential_role(&pool, admin_id, true).await;
    let pending_grant = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO access_grants
         (id,org_id,account_id,role_id,scope_kind,valid_from,status,effective_in_setup,change_mode,reason_code,granted_by)
         VALUES (gen_random_uuid(),$1,$2,$4,'TENANT',clock_timestamp()+interval '1 day','ACTIVE',true,'SETUP','TEST',$5),
                ($6,$1,$3,$4,'TENANT',clock_timestamp(),'PENDING',true,'SETUP','TEST',$5)",
    )
    .bind(OrgId::one().as_uuid())
    .bind(scheduled_target_id.as_uuid())
    .bind(pending_target_id.as_uuid())
    .bind(role_id)
    .bind(admin_id.as_uuid())
    .bind(pending_grant)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO user_role_grants_pending (org_id,grant_id,activates_at)
         VALUES ($1,$2,clock_timestamp()+interval '1 day')",
    )
    .bind(OrgId::one().as_uuid())
    .bind(pending_grant)
    .execute(&pool)
    .await
    .unwrap();
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

    let service =
        build_router(app_state(pool.clone(), private_key_pem.to_string(), public_key_pem).unwrap());
    let (admin_access, mut admin_key, admin_credential) =
        passkey_session_with_key(&service, &pool, admin_id).await;
    let step_up = start_step_up_assertion(&service, &mut admin_key, &admin_credential).await;
    let refused = post_raw(
        service.clone(),
        "/api/v1/auth/admin/credential-reset",
        Some(&admin_access),
        json!({ "user_id": target_id.as_uuid(), "step_up": step_up }),
    )
    .await;
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    let body: Value =
        serde_json::from_slice(&to_bytes(refused.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body["error"]["code"], "credential_reset_authority_required");
    let passkeys: i64 =
        sqlx::query_scalar("SELECT count(*) FROM auth_webauthn_credentials WHERE user_id=$1")
            .bind(target_id.as_uuid())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        passkeys, 1,
        "a refused reset preserves the target's passkey"
    );
    let codes: i64 =
        sqlx::query_scalar("SELECT count(*) FROM auth_bootstrap_credentials WHERE user_id=$1")
            .bind(target_id.as_uuid())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(codes, 0, "a refused reset mints no recovery code");

    let access_only_role = seed_credential_role(&pool, admin_id, false).await;
    sqlx::query(
        "INSERT INTO access_grants \
         (org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by) \
         VALUES ($1,$2,$3,'TENANT',now()-interval '1 day',true,'SETUP','TEST',$4)",
    )
    .bind(OrgId::one().as_uuid())
    .bind(admin_id.as_uuid())
    .bind(access_only_role)
    .bind(target_id.as_uuid())
    .execute(&pool)
    .await
    .unwrap();
    let step_up = start_step_up_assertion(&service, &mut admin_key, &admin_credential).await;
    let refused = post_raw(
        service.clone(),
        "/api/v1/auth/admin/credential-reset",
        Some(&admin_access),
        json!({ "user_id": target_id.as_uuid(), "step_up": step_up }),
    )
    .await;
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    let body: Value =
        serde_json::from_slice(&to_bytes(refused.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body["error"]["code"], "credential_reset_authority_required");

    for planned_target in [scheduled_target_id, pending_target_id] {
        let step_up = start_step_up_assertion(&service, &mut admin_key, &admin_credential).await;
        let refused = post_raw(
            service.clone(),
            "/api/v1/auth/admin/credential-reset",
            Some(&admin_access),
            json!({ "user_id": planned_target.as_uuid(), "step_up": step_up }),
        )
        .await;
        assert_eq!(refused.status(), StatusCode::FORBIDDEN);
        let body: Value =
            serde_json::from_slice(&to_bytes(refused.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body["error"]["code"], "credential_reset_authority_required");
    }

    let preserved: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM auth_webauthn_credentials WHERE user_id=$1), \
                (SELECT count(*) FROM auth_bootstrap_credentials WHERE user_id=$1)",
    )
    .bind(target_id.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(preserved, (1, 0));

    sqlx::query(
        "INSERT INTO access_grants \
         (org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by) \
         VALUES ($1,$2,$3,'TENANT',now()-interval '1 day',true,'SETUP','TEST',$4)",
    )
    .bind(OrgId::one().as_uuid())
    .bind(admin_id.as_uuid())
    .bind(role_id)
    .bind(target_id.as_uuid())
    .execute(&pool)
    .await
    .unwrap();
    let step_up = start_step_up_assertion(&service, &mut admin_key, &admin_credential).await;
    let reset: AdminCredentialResetResponse = post_json(
        service.clone(),
        "/api/v1/auth/admin/credential-reset",
        Some(&admin_access),
        json!({ "user_id": target_id.as_uuid(), "step_up": step_up }),
        StatusCode::OK,
    )
    .await;
    assert_eq!(reset.user_id, *target_id.as_uuid());

    let dissolved = Uuid::new_v4();
    sqlx::query("INSERT INTO org_units (org_id,id) VALUES ($1,$2)")
        .bind(OrgId::one().as_uuid())
        .bind(dissolved)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO org_unit_revisions \
         (org_id,org_unit_id,version,command_id,actor_id,payload_digest,attributes,receipt) \
         VALUES ($1,$2,1,$3,$4,$5,'{\"status\":\"dissolved\"}','{}')",
    )
    .bind(OrgId::one().as_uuid())
    .bind(dissolved)
    .bind(Uuid::new_v4())
    .bind(admin_id.as_uuid())
    .bind(vec![0u8; 32])
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO access_grants \
         (org_id,account_id,role_id,scope_kind,org_unit_id,valid_from,effective_in_setup,change_mode,reason_code,granted_by) \
         VALUES ($1,$2,$3,'DEPARTMENT',$4,now()-interval '1 day',true,'SETUP','TEST',$5)",
    )
    .bind(OrgId::one().as_uuid())
    .bind(scheduled_target_id.as_uuid())
    .bind(role_id)
    .bind(dissolved)
    .bind(admin_id.as_uuid())
    .execute(&pool)
    .await
    .unwrap();
    let step_up = start_step_up_assertion(&service, &mut admin_key, &admin_credential).await;
    let refused = post_raw(
        service.clone(),
        "/api/v1/auth/admin/credential-reset",
        Some(&admin_access),
        json!({ "user_id": scheduled_target_id.as_uuid(), "step_up": step_up }),
    )
    .await;
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    let body: Value =
        serde_json::from_slice(&to_bytes(refused.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body["error"]["code"], "credential_reset_authority_required");

    let step_up = start_step_up_assertion(&service, &mut admin_key, &admin_credential).await;
    let mut held = pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM access_roles WHERE org_id=$1 AND id=$2 FOR UPDATE")
        .bind(OrgId::one().as_uuid())
        .bind(role_id)
        .fetch_one(held.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE access_roles SET status='RETIRED' WHERE org_id=$1 AND id=$2")
        .bind(OrgId::one().as_uuid())
        .bind(role_id)
        .execute(held.as_mut())
        .await
        .unwrap();
    let refused = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        post_raw(
            service.clone(),
            "/api/v1/auth/admin/credential-reset",
            Some(&admin_access),
            json!({ "user_id": target_id.as_uuid(), "step_up": step_up }),
        ),
    )
    .await
    .expect("recovery must refuse contested role facts without waiting");
    held.rollback().await.unwrap();
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    let body: Value =
        serde_json::from_slice(&to_bytes(refused.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body["error"]["code"], "credential_reset_authority_required");
    for (account, expected) in [(target_id, (0, 1)), (scheduled_target_id, (1, 0))] {
        let preserved: (i64, i64) = sqlx::query_as(
            "SELECT (SELECT count(*) FROM auth_webauthn_credentials WHERE user_id=$1), \
                    (SELECT count(*) FROM auth_bootstrap_credentials WHERE user_id=$1)",
        )
        .bind(account.as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(preserved, expected);
    }
}
