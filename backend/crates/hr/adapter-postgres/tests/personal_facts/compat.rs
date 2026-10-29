// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

async fn assert_legacy_change_stays_unconfirmed(pool: PgPool, field: &str, value: &str) {
    let w = world(&pool).await;
    let old = json!({"name": "이하나", "relation": "SPOUSE", "phone": "+821012345678"});
    let mut confirmed = old.clone();
    confirmed["contact_notified"] = json!(true);
    correct_on(
        &pool,
        &w,
        w.in_a,
        json!({"emergency_contacts": [confirmed]}),
    )
    .await
    .unwrap();
    let before =
        w.hr.personal_facts(w.hr(w.hr_one), w.in_a)
            .await
            .unwrap()
            .emergency_contacts;
    let mut changed = old.clone();
    changed[field] = json!(value);
    correct_on(
        &pool,
        &w,
        w.in_a,
        json!({"emergency_contacts": [changed, old]}),
    )
    .await
    .unwrap();
    let contacts =
        w.hr.personal_facts(w.hr(w.hr_one), w.in_a)
            .await
            .unwrap()
            .emergency_contacts;
    assert_eq!(contacts[0][field], value);
    assert_eq!(contacts[0]["contact_notified"], false);
    assert!(contacts[0]["basis"].is_null());
    assert_eq!(contacts[1], before[0]);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn legacy_matching_requires_phone(pool: PgPool) {
    assert_legacy_change_stays_unconfirmed(pool, "phone", "+821099998888").await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn legacy_matching_requires_relation(pool: PgPool) {
    assert_legacy_change_stays_unconfirmed(pool, "relation", "PARENT").await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn released_client_resends_preserve_evidence_and_additions_stay_unconfirmed(pool: PgPool) {
    let w = world(&pool).await;
    let confirmed = json!({"name": "이하나", "relation": "SPOUSE", "phone": "+821012345678", "contact_notified": true});
    correct_on(
        &pool,
        &w,
        w.in_a,
        json!({"emergency_contacts": [confirmed]}),
    )
    .await
    .unwrap();
    let before =
        w.hr.personal_facts(w.hr(w.hr_one), w.in_a)
            .await
            .unwrap()
            .emergency_contacts;
    let old = json!({"name": "이하나", "relation": "SPOUSE", "phone": "010-1234-5678"});
    let new = json!({"name": "이두리", "relation": "PARENT", "phone": "02-123-4567"});
    correct_on(&pool, &w, w.in_a, json!({"emergency_contacts": [old]}))
        .await
        .unwrap();
    assert_eq!(
        w.hr.personal_facts(w.hr(w.hr_one), w.in_a)
            .await
            .unwrap()
            .emergency_contacts,
        before
    );
    correct_on(&pool, &w, w.in_a, json!({"emergency_contacts": [new, old]}))
        .await
        .unwrap();
    let after =
        w.hr.personal_facts(w.hr(w.hr_one), w.in_a)
            .await
            .unwrap()
            .emergency_contacts;
    assert_eq!(
        after[1], before[0],
        "the confirmed contact keeps all evidence when reordered"
    );
    assert_eq!(after[0]["contact_notified"], false);
    assert!(after[0]["basis"].is_null());
    correct_on(&pool, &w, w.in_a, json!({"emergency_contacts": [new, old]}))
        .await
        .unwrap();
    assert_eq!(
        w.hr.personal_facts(w.hr(w.hr_one), w.in_a)
            .await
            .unwrap()
            .emergency_contacts,
        after,
        "an old client cannot attest an unconfirmed contact by resending it"
    );
    let entries = ledger(&pool, w.in_a).await;
    assert_eq!(entries.last().unwrap().2[0]["contact_notified"], false);
    assert_eq!(entries.last().unwrap().2[1]["contact_notified"], true);

    let mut changed = new.clone();
    changed["phone"] = json!("010-9999-8888");
    changed["contact_notified"] = json!(false);
    let err = correct_on(
        &pool,
        &w,
        w.in_a,
        json!({"emergency_contacts": [changed, confirmed]}),
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, "emergency_contact_notice_unconfirmed");
    assert_eq!(
        w.hr.personal_facts(w.hr(w.hr_one), w.in_a)
            .await
            .unwrap()
            .emergency_contacts,
        after
    );
    changed["contact_notified"] = json!(true);
    correct_on(
        &pool,
        &w,
        w.in_a,
        json!({"emergency_contacts": [changed, confirmed]}),
    )
    .await
    .unwrap();
    let notified =
        w.hr.personal_facts(w.hr(w.hr_one), w.in_a)
            .await
            .unwrap()
            .emergency_contacts;
    assert_eq!(notified[0]["contact_notified"], true);
    assert_eq!(notified[0]["basis"], "VITAL_INTEREST_PENDING_COUNSEL");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn legacy_duplicate_cannot_reuse_one_contacts_confirmation(pool: PgPool) {
    let w = world(&pool).await;
    let old = json!({"name": "이하나", "relation": "SPOUSE", "phone": "+821012345678"});
    let mut confirmed = old.clone();
    confirmed["contact_notified"] = json!(true);
    correct_on(
        &pool,
        &w,
        w.in_a,
        json!({"emergency_contacts": [confirmed]}),
    )
    .await
    .unwrap();
    correct_on(&pool, &w, w.in_a, json!({"emergency_contacts": [old, old]}))
        .await
        .unwrap();
    let contacts =
        w.hr.personal_facts(w.hr(w.hr_one), w.in_a)
            .await
            .unwrap()
            .emergency_contacts;
    assert_eq!(contacts[0]["contact_notified"], true);
    assert_eq!(contacts[1]["contact_notified"], false);
    assert!(contacts[1]["basis"].is_null());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn legacy_request_note_and_second_person_do_not_attest_notice(pool: PgPool) {
    let w = world(&pool).await;
    let contact = json!({"name": "이하나", "relation": "SPOUSE", "phone": "010-1234-5678"});
    let mut body = create(
        "PROFILE_CORRECTION",
        "EMPLOYEE",
        w.in_a,
        json!({"changes": {"emergency_contacts": [contact]}}),
    );
    body.note = Some(
        json!({"contact_notified": true, "basis": "VITAL_INTEREST_PENDING_COUNSEL"}).to_string(),
    );
    let request =
        w.hr.create_change_request(w.admin(w.admin_a, w.branch_a), body)
            .await
            .unwrap();
    w.hr.decide_change_request(w.hr(w.hr_one), request.id, decide("APPLY"), SECOND)
        .await
        .unwrap();
    let contacts =
        w.hr.personal_facts(w.hr(w.hr_one), w.in_a)
            .await
            .unwrap()
            .emergency_contacts;
    assert_eq!(contacts[0]["contact_notified"], false);
    assert!(contacts[0]["basis"].is_null());
}
