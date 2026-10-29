// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn production_corrections_refuse_false_confirmation_even_in_a_ui_note(pool: PgPool) {
    let w = world(&pool).await;
    let at: OffsetDateTime = sqlx::query_scalar("SELECT updated_at FROM employees WHERE id = $1")
        .bind(w.in_a)
        .fetch_one(&pool)
        .await
        .unwrap();
    for note in [
        None,
        Some(
            json!({
                "basis": "VITAL_INTEREST_PENDING_COUNSEL", "basis_label": "검토 전",
                "contact_notified": false,
            })
            .to_string(),
        ),
        Some(json!({"contact_notified": true}).to_string()),
    ] {
        let body = serde_json::from_value(json!({
            "expected_updated_at": at.format(&Rfc3339).unwrap(),
            "changes": { "emergency_contacts": [{ "name": "이하나", "relation": "SPOUSE", "phone": "010-1234-5678", "contact_notified": false }] },
            "reason_code": "QUICK_EDIT", "note": note,
        })).unwrap();
        let err =
            w.hr.correct_employee(w.hr(w.hr_one), &passkey_service(), w.in_a, body, SECOND)
                .await
                .unwrap_err();
        assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(err.code, "emergency_contact_notice_unconfirmed");
        assert!(err.message.contains("검토 전"));
    }
    for notified in [Value::Null, json!(false)] {
        let err = correct_on(&pool, &w, w.in_a, json!({ "emergency_contacts": [{
            "name": "이하나", "relation": "SPOUSE", "phone": "010-1234-5678", "contact_notified": notified,
        }] })).await.unwrap_err();
        assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(err.code, "emergency_contact_notice_unconfirmed");
        assert!(err.message.contains("검토 전"));
    }
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM employee_emergency_contacts WHERE employee_id = $1",
    )
    .bind(w.in_a)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 0, "refused saves write nothing");
    assert!(ledger(&pool, w.in_a).await.is_empty());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn historical_contacts_do_not_gain_confirmation_or_basis_on_read(pool: PgPool) {
    let w = world(&pool).await;
    sqlx::query("INSERT INTO employee_personal_facts (org_id, employee_id) VALUES ($1, $2)")
        .bind(w.org)
        .bind(w.in_a)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO employee_emergency_contacts (org_id, employee_id, seq, name, relation, phone_e164, created_by) VALUES ($1, $2, 1, '이하나', 'SPOUSE', '+821012345678', $3)")
        .bind(w.org).bind(w.in_a).bind(w.hr_one).execute(&pool).await.unwrap();
    let facts = w.hr.personal_facts(w.hr(w.hr_one), w.in_a).await.unwrap();
    assert_eq!(facts.emergency_contacts.as_array().unwrap().len(), 1);
    let contact = &facts.emergency_contacts[0];
    assert_eq!(contact["contact_notified"], false);
    assert!(contact["basis"].is_null());
    assert!(contact["basis_label"].is_null());
    assert_eq!(contact["recorded_by"], w.hr_one.to_string());
    assert!(contact["recorded_at"].is_string());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn bulk_and_requests_cannot_bypass_notice_confirmation(pool: PgPool) {
    let w = world(&pool).await;
    let contact = json!({ "name": "이하나", "relation": "SPOUSE", "phone": "010-1234-5678" });
    {
        let mut contact = contact.clone();
        contact["contact_notified"] = json!(false);
        let changes = json!({"emergency_contacts": [contact]});
        let rows = json!([{ "employee_id": w.in_a, "changes": changes }]);
        let plan =
            w.hr.bulk_correct_register_facts(w.hr(w.hr_one), bulk(true, rows.clone()))
                .await
                .unwrap();
        assert!(plan.rows[0].error.is_some());
        let err =
            w.hr.bulk_correct_register_facts(w.hr(w.hr_one), bulk(false, rows))
                .await
                .unwrap_err();
        assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(err.code, "bulk_register_facts_refused");
        let err =
            w.hr.create_change_request(
                w.admin(w.admin_a, w.branch_a),
                create(
                    "PROFILE_CORRECTION",
                    "EMPLOYEE",
                    w.in_a,
                    json!({ "changes": changes }),
                ),
            )
            .await
            .unwrap_err();
        assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(err.code, "emergency_contact_notice_unconfirmed");
        assert!(err.message.contains("검토 전"));
    }
    assert!(ledger(&pool, w.in_a).await.is_empty());

    let mut confirmed = contact;
    confirmed["contact_notified"] = json!(true);
    let request =
        w.hr.create_change_request(
            w.admin(w.admin_a, w.branch_a),
            create(
                "PROFILE_CORRECTION",
                "EMPLOYEE",
                w.in_a,
                json!({ "changes": {"emergency_contacts": [confirmed]} }),
            ),
        )
        .await
        .unwrap();
    w.hr.decide_change_request(w.hr(w.hr_one), request.id, decide("APPLY"), SECOND)
        .await
        .unwrap();
    let facts = w.hr.personal_facts(w.hr(w.hr_one), w.in_a).await.unwrap();
    assert_eq!(facts.emergency_contacts.as_array().unwrap().len(), 1);
    assert_eq!(facts.emergency_contacts[0]["contact_notified"], true);
    assert_eq!(
        facts.emergency_contacts[0]["basis"],
        "VITAL_INTEREST_PENDING_COUNSEL"
    );
    assert_eq!(
        facts.emergency_contacts[0]["recorded_by"],
        w.hr_one.to_string()
    );
    correct_on(&pool, &w, w.in_a, json!({"emergency_contacts": []}))
        .await
        .unwrap();
    let facts = w.hr.personal_facts(w.hr(w.hr_one), w.in_a).await.unwrap();
    assert!(
        facts.emergency_contacts.is_null(),
        "clearing needs no confirmation"
    );
}
