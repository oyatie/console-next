// SPDX-License-Identifier: LicenseRef-Proprietary
//! Close receipts preserve the database instants and serialize as UTC RFC 3339.
use crate::*;
use time::format_description::well_known::Rfc3339;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn close_post_and_get_return_the_same_stored_timestamps(pool: PgPool) {
    let keys = keys();
    let personas = seed_personas(&pool, &keys).await;
    let app = build_router(app_state(runtime_role_pool(&pool).await, keys.public_pem).unwrap());
    for branch in [Some(personas.branch), None] {
        let created = post(
            app.clone(),
            CLOSES,
            &personas.executive_token,
            json!({"month": "2026-08", "branch_scope": branch, "attest": true}),
        )
        .await;
        assert_eq!(created.status, StatusCode::CREATED, "{:?}", created.json);
        let uri = branch.map_or_else(
            || format!("{CLOSES}?month=2026-08"),
            |id| format!("{CLOSES}?month=2026-08&branch_id={id}"),
        );
        let board = get(app.clone(), &uri, &personas.executive_token).await;
        assert_eq!(board.status, StatusCode::OK, "{:?}", board.json);
        assert_eq!(board.json["items"].as_array().unwrap().len(), 1);
        let saved = &board.json["items"][0]["close"];
        for field in ["attested_at", "closed_at"] {
            assert_eq!(
                created.json[field], saved[field],
                "{field} must be read from the inserted row"
            );
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn close_and_amendment_timestamps_are_rfc3339_utc(pool: PgPool) {
    let keys = keys();
    let personas = seed_personas(&pool, &keys).await;
    let app = build_router(app_state(runtime_role_pool(&pool).await, keys.public_pem).unwrap());
    let created = post(
        app.clone(),
        CLOSES,
        &personas.executive_token,
        json!({"month": "2026-08", "attest": true}),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{:?}", created.json);
    let uri = format!(
        "{CLOSES}/{}/amendments",
        created.json["id"].as_str().unwrap()
    );
    let request = Request::builder()
        .method("POST")
        .uri(uri)
        .header(
            header::AUTHORIZATION,
            format!("Bearer {}", personas.executive_token),
        )
        .header(header::CONTENT_TYPE, "application/json")
        .header("Idempotency-Key", "close-timestamp-amendment")
        .body(Body::from(
            json!({"reason": "correction", "detail": "confirmed record"}).to_string(),
        ))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let amendment: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    let board = get(
        app,
        &format!("{CLOSES}?month=2026-08"),
        &personas.executive_token,
    )
    .await;
    assert_eq!(board.status, StatusCode::OK, "{:?}", board.json);
    let saved = &board.json["items"][0]["close"];
    assert_eq!(saved["amendments"][0], amendment);
    for timestamp in [
        &created.json["attested_at"],
        &created.json["closed_at"],
        &saved["attested_at"],
        &saved["closed_at"],
        &amendment["created_at"],
    ] {
        let text = timestamp.as_str().unwrap();
        assert!(text.ends_with('Z'), "expected UTC Z: {text}");
        OffsetDateTime::parse(text, &Rfc3339).expect("timestamp must parse as RFC 3339");
    }
}
