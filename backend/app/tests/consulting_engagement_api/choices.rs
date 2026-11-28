// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn consulting_choices_follow_tenant_enrollment_source_kind_and_approval_ownership(
    pool: PgPool,
) {
    let f = seed_fixture(&pool).await;
    let keys = keys();
    let token = bearer(&pool, &keys, f.requester, f.org).await;
    let approver_token = bearer(&pool, &keys, f.approver, f.org).await;
    let service = build_router(app_state(runtime_role_pool(&pool).await, &keys));
    let options = |query: String, tok: String| {
        let app = service.clone();
        async move {
            send(
                app,
                "GET",
                &format!("/api/v1/consulting/options?{query}"),
                Some(&tok),
                None,
            )
            .await
        }
    };
    let caps = |tok: String| {
        let app = service.clone();
        async move { send(app, "GET", "/api/v1/me/authz", Some(&tok), None).await }
    };
    let has_consulting = |data: &Value| {
        data["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["feature"] == "served_consulting")
    };
    assert!(has_consulting(&caps(token.clone()).await.json));
    for (kind, id) in [
        ("CUSTOMER", f.customer),
        ("DOCUMENT", f.document),
        ("EVIDENCE", f.evidence),
        ("KPI_DEFINITION", f.kpi),
        ("ONTOLOGY_INSTANCE", f.ontology),
    ] {
        let page = options(format!("kind={kind}"), token.clone()).await;
        assert_eq!(page.status, StatusCode::OK, "{kind}: {}", page.json);
        assert_eq!(page.json["items"].as_array().unwrap().len(), 1);
        assert_eq!(response_uuid(&page.json["items"][0], "id"), id);
        assert!(page.json["next_offset"].is_null());
    }
    let id = Uuid::new_v4();
    let permission = seed_approval(&pool, f.org, f.requester, f.approver, id).await;
    let own = options(format!("kind=APPROVAL&engagementId={id}"), token.clone()).await;
    assert_eq!(own.json["items"], json!([]));
    let valid = options(
        format!("kind=APPROVAL&engagementId={id}"),
        approver_token.clone(),
    )
    .await;
    assert_eq!(response_uuid(&valid.json["items"][0], "id"), permission);
    let other = options(
        format!("kind=APPROVAL&engagementId={}", f.other_org_engagement),
        approver_token.clone(),
    )
    .await;
    assert_eq!(other.json["items"], json!([]));
    sqlx::query(
        "INSERT INTO gov_approval_consumptions(org_id,approval_id,consumed_by) VALUES($1,$2,$3)",
    )
    .bind(f.org.as_uuid())
    .bind(permission)
    .bind(f.approver.as_uuid())
    .execute(&pool)
    .await
    .unwrap();
    let consumed = options(format!("kind=APPROVAL&engagementId={id}"), approver_token).await;
    assert_eq!(consumed.json["items"], json!([]));
    for _ in 0..30 {
        seed_reference(&pool, f.org, f.requester, "EVIDENCE").await;
    }
    let first = options("kind=EVIDENCE".into(), token.clone()).await;
    let last = options("kind=EVIDENCE&offset=30".into(), token.clone()).await;
    assert_eq!(first.json["next_offset"], 30);
    let items = first.json["items"].as_array().unwrap();
    assert_eq!(items.len(), 30);
    assert_eq!(last.json["items"].as_array().unwrap().len(), 1);
    assert!(!items.contains(&last.json["items"][0]));
    let missing = options("kind=EVIDENCE&q=missing".into(), token.clone()).await;
    assert_eq!(missing.json["items"], json!([]));
    let outsider = UserId::new();
    seed_user(&pool, f.org, outsider, "No consulting grant").await;
    let outsider = bearer(&pool, &keys, outsider, f.org).await;
    assert!(!has_consulting(&caps(outsider.clone()).await.json));
    assert_eq!(
        options("kind=EVIDENCE".into(), outsider).await.status,
        StatusCode::FORBIDDEN
    );
    sqlx::query("INSERT INTO tenant_module_enrollments(org_id,module_key,enabled,change_ref) VALUES ($1,'consulting',false,'test-withdrawal')").bind(f.org.as_uuid()).execute(&pool).await.unwrap();
    assert!(!has_consulting(&caps(token.clone()).await.json));
    assert_eq!(
        options("kind=EVIDENCE".into(), token).await.status,
        StatusCode::FORBIDDEN
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_in_flight_child_write_finishes_before_a_concurrent_terminal_transition(pool: PgPool) {
    let fixture = seed_fixture(&pool).await;
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO consulting_engagements(org_id,customer_id,title,idempotency_key,idempotency_request_hash,created_by)
         VALUES ($1,$2,'Concurrent diagnostic','child-first',repeat('a',64),$3) RETURNING id")
        .bind(fixture.org.as_uuid()).bind(fixture.customer).bind(fixture.requester.as_uuid())
        .fetch_one(&pool).await.unwrap();
    let mut child = pool.begin().await.unwrap();
    sqlx::query("INSERT INTO consulting_diagnostics(org_id,engagement_id,summary,created_by) VALUES ($1,$2,'Under review',$3)")
        .bind(fixture.org.as_uuid()).bind(id).bind(fixture.requester.as_uuid()).execute(child.as_mut()).await.unwrap();
    let mut closer = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL lock_timeout='200ms'")
        .execute(closer.as_mut())
        .await
        .unwrap();
    let close =
        "UPDATE consulting_engagements SET status='SUSTAINED',version=version+1 WHERE id=$1";
    let result = sqlx::query(close).bind(id).execute(closer.as_mut()).await;
    let error = result.expect_err("closing the engagement must wait for its in-flight evidence");
    assert_eq!(
        error.as_database_error().and_then(|e| e.code()).as_deref(),
        Some("55P03")
    );
    closer.rollback().await.unwrap();
    child.commit().await.unwrap();
    let closed = sqlx::query(close).bind(id).execute(&pool).await.unwrap();
    assert_eq!(closed.rows_affected(), 1);
}
