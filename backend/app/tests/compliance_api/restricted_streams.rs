// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn ceo_covert_audit_stream_requires_clearance_and_audits_successful_read(pool: PgPool) {
    let fixture = TestFixture::new(&pool, "CEO Audit", "CEO Audit Branch").await;
    let sensitive_event_id = seed_ceo_covert_audit_event(&pool, fixture.admin_id).await;
    grant_ceo_covert_clearance(&pool, fixture.admin_id).await;
    seed_subject_freshness(&pool, fixture.admin_id).await;
    let service = build_router(app_state(pool.clone(), fixture.public_key_pem.clone()).unwrap());

    for (token, allowed) in [
        (&fixture.admin_token, true),
        (&fixture.mechanic_token, false),
    ] {
        let available =
            get_json(service.clone(), "/api/v1/audit-streams/availability", token).await;
        assert_eq!(available.status, StatusCode::OK);
        assert_eq!(
            available.json,
            json!({"events":allowed,"access_events":allowed})
        );
        assert_eq!(
            available.headers[header::CACHE_CONTROL],
            "private, no-store"
        );
    }
    assert_eq!(audit_count(&pool, "audit_stream.ceo_read").await, 0);
    assert_eq!(audit_count(&pool, "audit_stream.access_log_read").await, 0);
    let denied = get(
        service.clone(),
        "/api/v1/audit-streams/ceo-covert/events",
        &fixture.mechanic_token,
    )
    .await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN, "{}", denied.body);
    assert_eq!(audit_count(&pool, "audit_stream.ceo_read").await, 0);

    let allowed = get_json(
        service.clone(),
        "/api/v1/audit-streams/ceo-covert/events?limit=10&offset=0",
        &fixture.admin_token,
    )
    .await;
    assert_eq!(allowed.status, StatusCode::OK, "{:?}", allowed.json);
    assert_eq!(allowed.headers[header::CACHE_CONTROL], "private, no-store");
    assert_eq!(allowed.json["stream_key"], "ceo_covert_audit");
    assert_eq!(allowed.json["read_kind"], "events");
    assert_eq!(allowed.json["total"], 1);
    assert_eq!(
        allowed.json["items"][0]["id"],
        sensitive_event_id.to_string()
    );
    assert_eq!(allowed.json["items"][0]["sensitivity"], "CEO_COVERT");
    assert_eq!(allowed.json["access_audit_id"].as_str().unwrap().len(), 36);
    assert_eq!(audit_count(&pool, "audit_stream.ceo_read").await, 1);
    sqlx::query("UPDATE clearance_assignments SET status='REVOKED' WHERE user_id=$1")
        .bind(fixture.admin_id.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let available = get_json(
        service.clone(),
        "/api/v1/audit-streams/availability",
        &fixture.admin_token,
    )
    .await;
    assert_eq!(
        available.json,
        json!({"events":false,"access_events":false})
    );
    let denied = get(
        service,
        "/api/v1/audit-streams/ceo-covert/events",
        &fixture.admin_token,
    )
    .await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN);
    assert_eq!(audit_count(&pool, "audit_stream.ceo_read").await, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn ceo_covert_access_log_read_is_clearance_gated_and_audited(pool: PgPool) {
    let fixture = TestFixture::new(&pool, "CEO Access", "CEO Access Branch").await;
    seed_ceo_covert_audit_event(&pool, fixture.admin_id).await;
    grant_ceo_covert_clearance(&pool, fixture.admin_id).await;
    seed_subject_freshness(&pool, fixture.admin_id).await;
    let service = build_router(app_state(pool.clone(), fixture.public_key_pem.clone()).unwrap());

    let first_read = get_json(
        service.clone(),
        "/api/v1/audit-streams/ceo-covert/events",
        &fixture.admin_token,
    )
    .await;
    assert_eq!(first_read.status, StatusCode::OK, "{:?}", first_read.json);
    assert_eq!(audit_count(&pool, "audit_stream.ceo_read").await, 1);

    let denied = get(
        service.clone(),
        "/api/v1/audit-streams/ceo-covert/access-events",
        &fixture.mechanic_token,
    )
    .await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN, "{}", denied.body);
    assert_eq!(audit_count(&pool, "audit_stream.access_log_read").await, 0);

    let access_log = get_json(
        service,
        "/api/v1/audit-streams/ceo-covert/access-events?limit=10&offset=0",
        &fixture.admin_token,
    )
    .await;
    assert_eq!(access_log.status, StatusCode::OK, "{:?}", access_log.json);
    assert_eq!(access_log.json["stream_key"], "ceo_covert_audit");
    assert_eq!(access_log.json["read_kind"], "access_events");
    assert_eq!(access_log.json["total"], 1);
    assert_eq!(
        access_log.json["items"][0]["action"],
        "audit_stream.ceo_read"
    );
    assert_eq!(access_log.json["items"][0]["target_id"], "ceo_covert_audit");
    assert_eq!(audit_count(&pool, "audit_stream.access_log_read").await, 1);
}
