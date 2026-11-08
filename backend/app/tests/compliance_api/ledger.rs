// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn admin_can_read_and_export_consent_ledger(pool: PgPool) {
    let fixture = TestFixture::new(&pool, "Consent Ledger", "Ledger Branch").await;
    let service = build_router(app_state(pool.clone(), fixture.public_key_pem.clone()).unwrap());

    let grant = post_json(
        service.clone(),
        "/api/v1/location-consent/grant",
        &fixture.mechanic_token,
        json!({ "branch_id": fixture.branch_id }),
    )
    .await;
    assert_eq!(grant.status, StatusCode::OK, "{:?}", grant.json);

    let ledger = get_json(
        service.clone(),
        &format!(
            "/api/v1/location-consents/ledger?branch_id={}",
            fixture.branch_id.as_uuid()
        ),
        &fixture.admin_token,
    )
    .await;
    assert_eq!(ledger.status, StatusCode::OK, "{:?}", ledger.json);
    assert_eq!(ledger.json["items"][0]["action"], "consent.grant");
    assert_eq!(ledger.json["total"], 1);
    let stored: (OffsetDateTime, OffsetDateTime) =
        sqlx::query_as("SELECT occurred_at, created_at FROM location_consent_ledger WHERE id = $1")
            .bind(
                ledger.json["items"][0]["id"]
                    .as_str()
                    .unwrap()
                    .parse::<uuid::Uuid>()
                    .unwrap(),
            )
            .fetch_one(&pool)
            .await
            .unwrap();
    for (field, stored) in [("occurred_at", stored.0), ("created_at", stored.1)] {
        let wire = ledger.json["items"][0][field]
            .as_str()
            .expect("RFC 3339 string");
        assert!(wire.ends_with('Z'), "{wire}");
        assert_eq!(OffsetDateTime::parse(wire, &Rfc3339).unwrap(), stored);
    }

    let csv = get(
        service,
        &format!(
            "/api/v1/location-consents/ledger.csv?branch_id={}",
            fixture.branch_id.as_uuid()
        ),
        &fixture.admin_token,
    )
    .await;
    assert_eq!(csv.status, StatusCode::OK, "{}", csv.body);
    assert!(
        csv.headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/csv"))
    );
    assert!(csv.body.contains("consent.grant"));
    for wire in csv.body.lines().nth(1).unwrap().rsplit(',').take(2) {
        assert!(wire.ends_with('Z'), "{wire}");
        time::OffsetDateTime::parse(wire, &time::format_description::well_known::Rfc3339).unwrap();
    }
    assert!(!csv.body.contains("37.5665"));
}
