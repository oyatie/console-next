#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn create_site_rejects_one_sided_coordinate(pool: PgPool) {
    console_platform_request_context::scope_org(console_kernel_core::OrgId::one(), async move {
        let harness = Harness::new(&pool, "ADMIN").await;
        let (status, body) = harness
            .send(
                "POST",
                "/api/v1/customers",
                Some(json_body(&json!({ "name": "좌표고객" }))),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body:?}");
        let customer_id = body["id"].as_str().unwrap().to_owned();

        // Latitude without longitude is rejected before the write (422).
        let (status, _) = harness
            .send(
                "POST",
                "/api/v1/sites",
                Some(json_body(&json!({
                    "customer_id": customer_id,
                    "name": "반쪽좌표현장",
                    "latitude": 37.5
                }))),
            )
            .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    })
    .await;
}
