// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

async fn patch_contacts(pool: &PgPool, f: &Fixture, contacts: Value) -> (StatusCode, Value) {
    let at: OffsetDateTime = sqlx::query_scalar("SELECT updated_at FROM employees WHERE id = $1")
        .bind(f.ids[0])
        .fetch_one(pool)
        .await
        .unwrap();
    let app = console_hr_rest::corrections::router(f.hr.clone(), passkey_service())
        .layer(Extension(f.principal.clone()));
    let response = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/api/v1/employees/{}", f.ids[0]))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"expected_updated_at": at.format(&Rfc3339).unwrap(),
            "reason_code": "QUICK_EDIT", "changes": {"emergency_contacts": contacts}})
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn released_client_patch_keeps_confirmation_and_records_new_contacts_without_it(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    let old = json!({"name": "이하나", "relation": "SPOUSE", "phone": "010-1234-5678"});
    let mut confirmed = old.clone();
    confirmed["contact_notified"] = json!(true);
    let (status, body) = patch_contacts(&pool, &f, json!([confirmed])).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let facts = || f.hr.personal_facts(f.principal.clone(), f.ids[0]);
    let before = facts().await.unwrap().emergency_contacts;
    let (status, body) = patch_contacts(&pool, &f, json!([old])).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(facts().await.unwrap().emergency_contacts, before);

    let new = json!({"name": "이두리", "relation": "PARENT", "phone": "02-123-4567"});
    let (status, body) = patch_contacts(&pool, &f, json!([new, old])).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let contacts = facts().await.unwrap().emergency_contacts;
    assert_eq!(contacts[1], before[0]);
    assert_eq!(contacts[0]["contact_notified"], false);
    assert!(contacts[0]["basis"].is_null());
    let mut explicit = new;
    explicit["contact_notified"] = json!(false);
    let (status, body) = patch_contacts(&pool, &f, json!([explicit, confirmed])).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(facts().await.unwrap().emergency_contacts, contacts);
    explicit["phone"] = json!("010-9999-8888");
    let (status, body) = patch_contacts(&pool, &f, json!([explicit, confirmed])).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        body["error"]["code"],
        "emergency_contact_notice_unconfirmed"
    );
    assert_eq!(facts().await.unwrap().emergency_contacts, contacts);
}
