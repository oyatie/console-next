// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use time::macros::datetime;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn contacts_emit_stored_fractional_utc_timestamps(pool: PgPool) {
    let w = world(&pool).await;
    correct_on(&pool, &w, w.in_a, json!({"emergency_contacts": [
        {"name": "이하나", "relation": "SPOUSE", "phone": "010-1234-5678", "contact_notified": true}
    ]})).await.unwrap();
    let at = datetime!(2026-11-05 12:31:02.238349 +09:00);
    sqlx::query("UPDATE employee_emergency_contacts SET created_at=$2 WHERE employee_id=$1")
        .bind(w.in_a)
        .bind(at)
        .execute(&pool)
        .await
        .unwrap();
    let facts = w.hr.personal_facts(w.hr(w.hr_one), w.in_a).await.unwrap();
    let wire = serde_json::to_value(facts).unwrap();
    assert_eq!(
        wire["emergency_contacts"][0]["recorded_at"],
        "2026-11-05T03:31:02.238349Z"
    );
    let updated = wire["updated_at"].as_str().unwrap();
    assert!(updated.ends_with('Z'), "{updated}");
    OffsetDateTime::parse(updated, &Rfc3339).unwrap();
}
