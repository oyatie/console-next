// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn void_and_undo_preserve_legacy_and_confirmed_contact_evidence(pool: PgPool) {
    let w = world(&pool).await;
    sqlx::query("INSERT INTO employee_personal_facts (org_id, employee_id) VALUES ($1, $2)")
        .bind(w.org)
        .bind(w.in_a)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO employee_emergency_contacts (org_id, employee_id, seq, name, relation, phone_e164, created_by) VALUES ($1, $2, 1, '이하나', 'SPOUSE', '+821012345678', $3), ($1, $2, 2, '이두리', 'PARENT', '+8221234567', $3)")
        .bind(w.org).bind(w.in_a).bind(w.hr_two).execute(&pool).await.unwrap();
    let before =
        w.hr.personal_facts(w.hr(w.hr_one), w.in_a)
            .await
            .unwrap()
            .emergency_contacts;
    let inputs = json!([
        {"name": "이하나", "relation": "SPOUSE", "phone": "+821012345678", "contact_notified": false},
        {"name": "이두리", "relation": "PARENT", "phone": "+8221234567", "contact_notified": false}
    ]);
    correct_on(
        &pool,
        &w,
        w.in_a,
        json!({"emergency_contacts": [inputs[1]]}),
    )
    .await
    .unwrap();
    let after =
        w.hr.personal_facts(w.hr(w.hr_one), w.in_a)
            .await
            .unwrap()
            .emergency_contacts;
    assert_eq!(
        after,
        json!([before[1]]),
        "removing a sibling cannot attest or restamp the survivor"
    );
    correct_on(&pool, &w, w.in_a, json!({"emergency_contacts": inputs}))
        .await
        .unwrap();
    assert_eq!(
        w.hr.personal_facts(w.hr(w.hr_one), w.in_a)
            .await
            .unwrap()
            .emergency_contacts,
        before,
        "undo restores the original evidence"
    );
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM employee_emergency_contacts WHERE employee_id = $1",
    )
    .bind(w.in_a)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        count, 2,
        "undo restores rows rather than inserting new evidence"
    );
    let entries = ledger(&pool, w.in_a).await;
    assert_eq!(
        entries[0].1,
        Some(inputs.clone()),
        "ledger uses writable values, not evidence"
    );
    let mut changed = inputs.clone();
    changed[0]["phone"] = json!("+821099998888");
    let err = correct_on(&pool, &w, w.in_a, json!({"emergency_contacts": changed}))
        .await
        .unwrap_err();
    assert_eq!(err.code, "emergency_contact_notice_unconfirmed");

    changed[0]["contact_notified"] = json!(true);
    correct_on(&pool, &w, w.in_a, json!({"emergency_contacts": changed}))
        .await
        .unwrap();
    let recorded =
        w.hr.personal_facts(w.hr(w.hr_one), w.in_a)
            .await
            .unwrap()
            .emergency_contacts;
    assert_eq!(recorded[0]["recorded_by"], w.hr_one.to_string());
    assert_eq!(recorded[1], before[1]);
    correct_on(
        &pool,
        &w,
        w.in_a,
        json!({"emergency_contacts": [changed[0]]}),
    )
    .await
    .unwrap();
    assert_eq!(
        w.hr.personal_facts(w.hr(w.hr_one), w.in_a)
            .await
            .unwrap()
            .emergency_contacts,
        json!([recorded[0]])
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn repeated_contact_import_is_unchanged(pool: PgPool) {
    let w = world(&pool).await;
    let rows = json!([{ "employee_id": w.in_a, "changes": {"emergency_contacts": [
        {"name": "이하나", "relation": "SPOUSE", "phone": "+821012345678", "contact_notified": true}
    ]}}]);
    w.hr.bulk_correct_register_facts(w.hr(w.hr_one), bulk(false, rows.clone()))
        .await
        .unwrap();
    let before =
        w.hr.personal_facts(w.hr(w.hr_one), w.in_a)
            .await
            .unwrap()
            .emergency_contacts;
    let result =
        w.hr.bulk_correct_register_facts(w.hr(w.hr_one), bulk(false, rows))
            .await
            .unwrap();
    assert!(result.rows[0].changed.is_empty());
    assert_eq!(ledger(&pool, w.in_a).await.len(), 1);
    assert_eq!(
        w.hr.personal_facts(w.hr(w.hr_one), w.in_a)
            .await
            .unwrap()
            .emergency_contacts,
        before
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn notice_basis_constraint_tracks_evidence_without_freezing_the_basis_code(pool: PgPool) {
    let w = world(&pool).await;
    for (basis, notified, allowed) in [
        (Some("FUTURE_COUNSEL_BASIS"), true, true),
        (None, false, true),
        (None, true, false),
        (Some("FUTURE_COUNSEL_BASIS"), false, false),
    ] {
        let result = sqlx::query("INSERT INTO employee_emergency_contacts (org_id, employee_id, seq, name, relation, phone_e164, created_by, basis, contact_notified, voided_at) VALUES ($1, $2, 1, '이하나', 'SPOUSE', '+821012345678', $3, $4, $5, now())")
            .bind(w.org).bind(w.in_a).bind(w.hr_one).bind(basis).bind(notified).execute(&pool).await;
        if allowed {
            result.unwrap();
        } else {
            assert_eq!(
                result
                    .unwrap_err()
                    .as_database_error()
                    .unwrap()
                    .code()
                    .as_deref(),
                Some("23514")
            );
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn undo_restores_a_voided_legacy_contact_without_attesting_notice(pool: PgPool) {
    let w = world(&pool).await;
    sqlx::query("INSERT INTO employee_personal_facts (org_id, employee_id) VALUES ($1, $2)")
        .bind(w.org)
        .bind(w.in_a)
        .execute(&pool)
        .await
        .unwrap();
    let id: Uuid = sqlx::query_scalar("INSERT INTO employee_emergency_contacts (org_id, employee_id, seq, name, relation, phone_e164, created_by, voided_at) VALUES ($1, $2, 1, '이하나', 'SPOUSE', '+821012345678', $3, now()) RETURNING id")
        .bind(w.org).bind(w.in_a).bind(w.hr_two).fetch_one(&pool).await.unwrap();
    sqlx::query("UPDATE employee_emergency_contacts SET created_at = now() - interval '1 day' WHERE id = $1")
        .bind(id).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO employee_emergency_contacts (org_id, employee_id, seq, name, relation, phone_e164, created_by, voided_at) VALUES ($1, $2, 1, '이하나', 'SPOUSE', '+821012345678', $3, now() - interval '1 hour')")
        .bind(w.org).bind(w.in_a).bind(w.hr_one).execute(&pool).await.unwrap();
    correct_on(&pool, &w, w.in_a, json!({"emergency_contacts": [
        {"name": "이하나", "relation": "SPOUSE", "phone": "+821012345678", "contact_notified": false}
    ]})).await.unwrap();
    let restored: (Uuid, Uuid, bool, Option<String>) = sqlx::query_as("SELECT id, created_by, contact_notified, basis FROM employee_emergency_contacts WHERE employee_id = $1 AND voided_at IS NULL")
        .bind(w.in_a).fetch_one(&pool).await.unwrap();
    assert_eq!(restored, (id, w.hr_two, false, None));
}
