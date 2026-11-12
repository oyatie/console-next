// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use sqlx::migrate::Migrator;
use std::borrow::Cow;
use tracing::instrument::WithSubscriber;

#[path = "warnings.rs"]
mod warnings;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn nationality_editor_reads_active_catalog_labels(pool: PgPool) {
    let w = world(&pool).await;
    let read = || w.hr.personal_facts(w.hr(w.hr_one), w.in_a);
    let facts = serde_json::to_value(read().await.unwrap()).unwrap();
    let options = facts["countries"].as_array().unwrap();
    assert_eq!(options.len(), 249);
    assert!(
        options.contains(&json!({"code": "GB", "label_ko": "영국", "label_en": "United Kingdom"}))
    );
    sqlx::query("UPDATE country_code_versions SET valid_from = CURRENT_DATE - 1, valid_to = CURRENT_DATE WHERE code = 'GB'").execute(&pool).await.unwrap();
    sqlx::query("UPDATE country_code_versions SET valid_from = CURRENT_DATE + 1 WHERE code = 'VN'")
        .execute(&pool)
        .await
        .unwrap();
    let facts = serde_json::to_value(read().await.unwrap()).unwrap();
    let options = facts["countries"].as_array().unwrap();
    assert_eq!(options.len(), 247);
    assert!(
        !options
            .iter()
            .any(|o| ["GB", "VN"].contains(&o["code"].as_str().unwrap()))
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unknown_nationality_is_refused_when_filing_a_request(pool: PgPool) {
    let w = world(&pool).await;
    for code in ["ZZ", "UK"] {
        let err =
            w.hr.create_change_request(
                w.admin(w.admin_a, w.branch_a),
                create(
                    "PROFILE_CORRECTION",
                    "EMPLOYEE",
                    w.in_a,
                    json!({"changes": {"nationality": code}}),
                ),
            )
            .await
            .unwrap_err();
        assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(err.code, "nationality_unknown");
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM change_requests WHERE org_id = $1")
        .bind(w.org)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0, "unapplicable requests must never be filed");
    let request =
        w.hr.create_change_request(
            w.admin(w.admin_a, w.branch_a),
            create(
                "PROFILE_CORRECTION",
                "EMPLOYEE",
                w.in_a,
                json!({"changes": {"nationality": " gb "}}),
            ),
        )
        .await
        .unwrap();
    w.hr.decide_change_request(w.hr(w.hr_one), request.id, decide("APPLY"), SECOND)
        .await
        .unwrap();
    assert_eq!(
        w.hr.personal_facts(w.hr(w.hr_one), w.in_a)
            .await
            .unwrap()
            .nationality
            .as_deref(),
        Some("GB")
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn nationality_membership_is_checked_before_writing_or_filing(pool: PgPool) {
    let w = world(&pool).await;
    for code in ["ZZ", "XK", "UK", "AA"] {
        let err = correct_on(&pool, &w, w.in_a, json!({"nationality": code}))
            .await
            .unwrap_err();
        assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(err.code, "nationality_unknown");
    }
    assert!(ledger(&pool, w.in_a).await.is_empty());
    correct_on(&pool, &w, w.in_a, json!({"nationality": " vn "}))
        .await
        .unwrap();
    assert_eq!(
        w.hr.personal_facts(w.hr(w.hr_one), w.in_a)
            .await
            .unwrap()
            .nationality
            .as_deref(),
        Some("VN")
    );
    assert_eq!(ledger(&pool, w.in_a).await[0].2, json!("VN"));
    let other = support::tenant(&pool).await;
    let user = support::user(&pool, other.org, None).await;
    assert!(
        w.hr.personal_facts(support::principal(other.org, user), w.in_a)
            .await
            .is_err()
    );
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE console_rt")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(other.org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM employee_personal_facts WHERE employee_id = $1")
            .bind(w.in_a)
            .fetch_one(tx.as_mut())
            .await
            .unwrap();
    assert_eq!(count, 0, "RLS hides a second tenant's nationality");
    tx.rollback().await.unwrap();
    correct_on(&pool, &w, w.in_a, json!({"nationality": null}))
        .await
        .unwrap();
    assert!(
        w.hr.personal_facts(w.hr(w.hr_one), w.in_a)
            .await
            .unwrap()
            .nationality
            .is_none()
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn country_versions_and_fk_are_enforced_for_the_runtime_role(pool: PgPool) {
    let w = world(&pool).await;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM country_code_versions WHERE label_ko <> '' AND label_en <> '' AND publisher = 'ISO 3166/MA' AND valid_to IS NULL")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(count, 249);
    for statement in [
        "INSERT INTO country_codes(code) VALUES ('ZZ')",
        "DELETE FROM country_codes WHERE code = 'KR'",
        "UPDATE country_codes SET code = 'ZZ' WHERE code = 'KR'",
        "INSERT INTO country_code_versions(code,label_ko,label_en,publisher,valid_from) VALUES ('ZZ','test','test','test',CURRENT_DATE)",
        "DELETE FROM country_code_versions WHERE code = 'KR'",
    ] {
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("SET LOCAL ROLE console_rt")
            .execute(tx.as_mut())
            .await
            .unwrap();
        let err = sqlx::query(statement)
            .execute(tx.as_mut())
            .await
            .unwrap_err();
        assert_eq!(
            err.as_database_error().unwrap().code().as_deref(),
            Some("42501"),
            "{statement}"
        );
        tx.rollback().await.unwrap();
    }
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE console_rt")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(w.org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let err = sqlx::query(
        "INSERT INTO employee_personal_facts(org_id,employee_id,nationality) VALUES($1,$2,'ZZ')",
    )
    .bind(w.org)
    .bind(w.in_a)
    .execute(tx.as_mut())
    .await
    .unwrap_err();
    assert_eq!(
        err.as_database_error().unwrap().constraint(),
        Some("employee_personal_facts_nationality_fkey")
    );
    tx.rollback().await.unwrap();
    sqlx::query("UPDATE country_code_versions SET valid_from = CURRENT_DATE - 1, valid_to = CURRENT_DATE WHERE code = 'VN'").execute(&pool).await.unwrap();
    let err = correct_on(&pool, &w, w.in_a, json!({"nationality": "VN"}))
        .await
        .unwrap_err();
    assert_eq!(err.code, "nationality_unknown", "exclusive end date");
    sqlx::query("UPDATE country_code_versions SET valid_from = CURRENT_DATE + 1, valid_to = NULL WHERE code = 'VN'").execute(&pool).await.unwrap();
    let err = correct_on(&pool, &w, w.in_a, json!({"nationality": "VN"}))
        .await
        .unwrap_err();
    assert_eq!(err.code, "nationality_unknown", "future version");
    sqlx::query("UPDATE country_code_versions SET valid_from = CURRENT_DATE WHERE code = 'VN'")
        .execute(&pool)
        .await
        .unwrap();
    correct_on(&pool, &w, w.in_a, json!({"nationality": "VN"}))
        .await
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE console_rt")
        .execute(tx.as_mut())
        .await
        .unwrap();
    let err =
        sqlx::query("UPDATE country_code_versions SET label_ko = 'changed' WHERE code = 'KR'")
            .execute(tx.as_mut())
            .await
            .unwrap_err();
    assert_eq!(
        err.as_database_error().unwrap().code().as_deref(),
        Some("42501")
    );
}

#[sqlx::test(migrations = false)]
async fn country_upgrade_preserves_unknown_values_and_unrelated_corrections(pool: PgPool) {
    let before = Migrator {
        migrations: Cow::Owned(
            console_platform_test_support::MIGRATOR
                .iter()
                .filter(|m| !m.description.contains("country nationality"))
                .cloned()
                .collect(),
        ),
        ..Migrator::DEFAULT
    };
    before.run(&pool).await.unwrap();
    let w = world(&pool).await;
    sqlx::query(
        "INSERT INTO employee_personal_facts(org_id,employee_id,nationality) VALUES($1,$2,'ZZ')",
    )
    .bind(w.org)
    .bind(w.in_a)
    .execute(&pool)
    .await
    .unwrap();
    let warnings = warnings::Warnings::default();
    console_platform_test_support::MIGRATOR
        .run(&pool)
        .with_subscriber(warnings.clone())
        .await
        .unwrap();
    let expected = format!(
        "nationality_unknown: org_id={}, code=ZZ, records=1; existing values retained",
        w.org
    );
    assert!(
        warnings
            .messages()
            .iter()
            .any(|message| message.contains(&expected)),
        "missing actionable migration report: {:?}",
        warnings.messages()
    );
    correct_on(&pool, &w, w.in_a, json!({"name_en": "KIM HANA"}))
        .await
        .unwrap();
    assert_eq!(
        w.hr.personal_facts(w.hr(w.hr_one), w.in_a)
            .await
            .unwrap()
            .nationality
            .as_deref(),
        Some("ZZ")
    );
    assert!(
        sqlx::query("UPDATE employee_personal_facts SET nationality = 'AA' WHERE employee_id = $1")
            .bind(w.in_a)
            .execute(&pool)
            .await
            .is_err()
    );
}
