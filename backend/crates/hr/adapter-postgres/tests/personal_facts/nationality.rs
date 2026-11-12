// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use sqlx::migrate::Migrator;
use std::borrow::Cow;

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
    console_platform_test_support::MIGRATOR
        .run(&pool)
        .await
        .unwrap();
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
