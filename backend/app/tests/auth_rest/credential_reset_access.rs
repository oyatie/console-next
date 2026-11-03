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

    let role_id: Uuid = sqlx::query_scalar(
        "INSERT INTO access_roles (org_id,name_ko,status,version,created_by) \
         VALUES ($1,'계정 복구 검증','ACTIVE',1,$2) RETURNING id",
    )
    .bind(OrgId::one().as_uuid())
    .bind(admin_id.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
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
        "INSERT INTO access_role_versions \
         (org_id,role_id,version,name_ko,status,change_mode,created_by) \
         VALUES ($1,$2,1,'계정 복구 검증','ACTIVE','SETUP',$3)",
    )
    .bind(OrgId::one().as_uuid())
    .bind(role_id)
    .bind(admin_id.as_uuid())
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) \
         VALUES ($1,$2,1,'access',ARRAY['edit']),($1,$2,1,'pay',ARRAY['view'])",
    )
    .bind(OrgId::one().as_uuid())
    .bind(role_id)
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

    let step_up = start_step_up_assertion(&service, &mut admin_key, &admin_credential).await;
    let authority_deadline: OffsetDateTime = sqlx::query_scalar(
        "UPDATE access_grants SET valid_to=clock_timestamp()+interval '3 seconds'
          WHERE org_id=$1 AND account_id=$2 AND role_id=$3 RETURNING valid_to",
    )
    .bind(OrgId::one().as_uuid())
    .bind(admin_id.as_uuid())
    .bind(role_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let mut held = pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM access_roles WHERE org_id=$1 AND id=$2 FOR UPDATE")
        .bind(OrgId::one().as_uuid())
        .bind(role_id)
        .fetch_one(held.as_mut())
        .await
        .unwrap();
    let blocker: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(held.as_mut())
        .await
        .unwrap();
    let route = service.clone();
    let access = admin_access.clone();
    let target = *target_id.as_uuid();
    let request = tokio::spawn(async move {
        post_raw(
            route,
            "/api/v1/auth/admin/credential-reset",
            Some(&access),
            json!({ "user_id": target, "step_up": step_up }),
        )
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
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
    .expect("credential reset must reach the locked authority facts");
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while OffsetDateTime::now_utc() < authority_deadline {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the actor grant must expire while the authority facts remain locked");
    held.rollback().await.unwrap();
    let refused = request.await.unwrap();
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    let body: Value =
        serde_json::from_slice(&to_bytes(refused.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body["error"]["code"], "credential_reset_authority_required");
}
