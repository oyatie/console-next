// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn pay_group_retry_replays_after_completion_once(pool: PgPool) {
    let (service, token, input, org, _, _) = fixture(&pool).await;
    for key in [
        String::new(),
        " ".repeat(16),
        "x".repeat(15),
        "x".repeat(201),
        "é".repeat(16),
    ] {
        let refused = keyed(service.clone(), &token, input.clone(), &key).await;
        assert_eq!(refused.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(refused.json["error"]["code"], "invalid_request_key");
        assert_eq!(counts(&pool, org).await, (0, 0, 0));
    }
    let key = Uuid::new_v4().to_string();
    let created = keyed(service.clone(), &token, input.clone(), &key).await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.json);
    let replay = keyed(
        service.clone(),
        &token,
        input.clone(),
        &format!("  {key}  "),
    )
    .await;
    assert_eq!(replay.status, created.status);
    assert_eq!(replay.json, created.json);
    let stored_status: Option<i16> = sqlx::query_scalar(
        "SELECT response_status FROM command_outcomes WHERE org_id=$1 AND idempotency_key=$2",
    )
    .bind(org.as_uuid())
    .bind(&key)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(stored_status, Some(StatusCode::CREATED.as_u16() as i16));
    assert_eq!(counts(&pool, org).await, (1, 1, 1));
    let fresh = keyed(service, &token, input, &Uuid::new_v4().to_string()).await;
    assert_eq!(fresh.status, StatusCode::CREATED);
    assert_ne!(fresh.json["id"], created.json["id"]);
    assert_eq!(counts(&pool, org).await, (2, 2, 2));
}
