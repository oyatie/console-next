// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

fn assert_timestamps(value: &Value) -> usize {
    match value {
        Value::Array(items) => items.iter().map(assert_timestamps).sum(),
        Value::Object(fields) => fields
            .iter()
            .map(|(key, value)| {
                if (key.ends_with("_at") || key == "at") && !value.is_null() {
                    let wire = value.as_str().unwrap();
                    assert!(wire.ends_with('Z'), "{key}: {wire}");
                    OffsetDateTime::parse(wire, &Rfc3339).unwrap();
                    1
                } else {
                    assert_timestamps(value)
                }
            })
            .sum(),
        _ => 0,
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn support_history_active_and_pending_emit_utc_timestamps(owner: PgPool) {
    let mut h = Support::new(owner).await;
    let (id, token) = h.active().await;
    ok(
        h.send("GET", READ, Value::Null, &token).await,
        StatusCode::OK,
    );
    let pending = Uuid::new_v4();
    ok(h.request(pending).await, StatusCode::CREATED);
    ok(h.approve(pending).await, StatusCode::OK);
    let active = h
        .send("GET", &format!("{TENANT}/active"), Value::Null, &h.tenant)
        .await;
    assert_eq!(active.0, StatusCode::OK);
    let active = active.1;
    assert_eq!(active["pending_count"], 1);
    assert_eq!(assert_timestamps(&active), 2);
    let history = h.send("GET", TENANT, Value::Null, &h.tenant).await;
    assert_eq!(history.0, StatusCode::OK);
    let history = history.1;
    assert_eq!(assert_timestamps(&history), 16);
    assert!(
        history["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s.get("request_assertion").is_none() && s.get("approval_assertion").is_none())
    );
    ok(
        h.send("POST", &format!("{TENANT}/{id}/end"), json!({}), &h.tenant)
            .await,
        StatusCode::OK,
    );
    let ended = h.send("GET", TENANT, Value::Null, &h.tenant).await;
    assert_eq!(ended.0, StatusCode::OK);
    let ended = ended.1;
    assert_eq!(assert_timestamps(&ended), 18);
}
