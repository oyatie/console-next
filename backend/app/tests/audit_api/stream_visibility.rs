// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn super_admin_audit_read_arms_org_and_isolates_cross_org_as_runtime_role(pool: PgPool) {
    let signing_key = SigningKey::generate();
    let private_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let user_id = UserId::new();
    let sae_branch = seed_branch(&pool, "SAE Region", "SAE Branch")
        .await
        .unwrap();
    seed_user_with_branch(&pool, user_id, "SUPER_ADMIN", sae_branch)
        .await
        .unwrap();
    insert_audit_for_org(
        &pool,
        Some(user_id),
        "work_order",
        "wo-sae",
        sae_branch,
        OrgId::one(),
    )
    .await
    .unwrap();

    // A separate stream owns the cleared read and its access record. These
    // tenant-local fixtures keep both out of the ordinary register.
    sqlx::query("INSERT INTO audit_stream_event_labels (org_id,audit_event_id,stream_key,sensitivity) SELECT org_id,id,'ceo_covert_audit','STANDARD' FROM audit_events WHERE target_id='wo-sae'")
        .execute(&pool).await.unwrap();
    insert_audit_for_org(
        &pool,
        Some(user_id),
        "work_order",
        "restricted",
        sae_branch,
        OrgId::one(),
    )
    .await
    .unwrap();
    sqlx::query("INSERT INTO audit_stream_event_labels (org_id,audit_event_id,stream_key,sensitivity) SELECT org_id,id,'ceo_covert_audit','CEO_COVERT' FROM audit_events WHERE target_id='restricted'")
        .execute(&pool).await.unwrap();
    for action in ["audit_stream.ceo_read", "audit_stream.access_log_read"] {
        sqlx::query("INSERT INTO audit_events (id,actor,action,target_type,target_id,trace_id,span_id,occurred_at,org_id) VALUES (gen_random_uuid(),$1,$2,'audit_stream','ceo_covert_audit',$3,$4,now(),$5)")
            .bind(user_id.as_uuid()).bind(action).bind("1".repeat(32)).bind("1".repeat(16)).bind(OrgId::one().as_uuid()).execute(&pool).await.unwrap();
    }

    // A row owned by a DIFFERENT tenant, on a DIFFERENT branch. Because the
    // SUPER_ADMIN's branch filter is `WHERE TRUE`, only the org GUC/RLS can keep
    // this out of the SAE admin's view.
    let other_org = seed_org(&pool, "other-tenant").await.unwrap();
    let other_branch = seed_branch_for_org(&pool, other_org, "Other Region", "Test Bay C")
        .await
        .unwrap();
    insert_audit_for_org(
        &pool,
        None,
        "work_order",
        "wo-other",
        other_branch,
        other_org,
    )
    .await
    .unwrap();

    let token = issue_token(
        &pool,
        private_pem.as_bytes(),
        public_key_pem.as_bytes(),
        user_id,
        vec!["SUPER_ADMIN".to_owned()],
        Vec::new(),
    )
    .await
    .unwrap();

    // Build the router off the `console_rt` pool so FORCE RLS actually applies —
    // an owner/BYPASSRLS pool would mask the unarmed-GUC break.
    let service =
        build_router(app_state(runtime_role_pool(&pool).await, public_key_pem.clone()).unwrap());
    let response = service
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/audit?target_type=work_order&limit=10&offset=0")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();
    let items = json["items"].as_array().unwrap();
    assert_eq!(
        items.len(),
        1,
        "armed SAE admin must see its own audit row (unarmed GUC would fail closed to zero rows): {items:?}"
    );
    assert_eq!(items[0]["target_id"], "wo-sae");
    let access_records = service
        .oneshot(
            Request::builder()
                .uri("/api/audit?target_type=audit_stream")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(access_records.status(), StatusCode::OK);
    let page: Value = serde_json::from_slice(
        &to_bytes(access_records.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(page["items"].as_array().unwrap().is_empty());
}
