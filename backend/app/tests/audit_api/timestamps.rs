// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn admin_reads_only_branch_scoped_audits_and_read_access_is_audited(pool: PgPool) {
    let signing_key = SigningKey::generate();
    let private_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let user_id = UserId::new();
    let branch_id = seed_branch(&pool, "Admin Region", "Admin Branch")
        .await
        .unwrap();
    seed_user_with_branch(&pool, user_id, "ADMIN", branch_id)
        .await
        .unwrap();
    let token = issue_token(
        &pool,
        private_pem.as_bytes(),
        public_key_pem.as_bytes(),
        user_id,
        vec!["ADMIN".to_owned()],
        vec![branch_id],
    )
    .await
    .unwrap();
    let other_branch = seed_branch(&pool, "Other Region", "Test Bay C")
        .await
        .unwrap();
    insert_audit(&pool, Some(user_id), "work_order", "wo-in-scope", branch_id)
        .await
        .unwrap();
    insert_audit(
        &pool,
        Some(user_id),
        "work_order",
        "wo-out-of-scope",
        other_branch,
    )
    .await
    .unwrap();
    let service = build_router(app_state(pool.clone(), public_key_pem).unwrap());

    let response = service
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
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["target_id"], "wo-in-scope");
    let wire = items[0]["occurred_at"].as_str().expect("RFC 3339 string");
    assert!(wire.ends_with('Z'), "{wire}");
    OffsetDateTime::parse(wire, &time::format_description::well_known::Rfc3339).unwrap();
    assert_eq!(items[0]["branch_id"], branch_id.to_string());
    assert_eq!(items[0]["ip"], "203.0.113.10");
    assert_eq!(items[0]["user_agent"], "Maintenance Console/1.0");
    assert_eq!(items[0]["auth_method"], "passkey");
    assert_eq!(items[0]["device"], "desktop-web");
    assert_eq!(items[0]["classification_badges"][0], "민감정보");
    assert_eq!(items[0]["classification_badges"][1], "대외비");
    assert_eq!(items[0]["anomaly"], true);
    assert_eq!(items[0]["reason"], "manager override");

    let read_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE actor = $1 AND action = 'audit.read'",
    )
    .bind(*user_id.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(read_count, 1);
}
